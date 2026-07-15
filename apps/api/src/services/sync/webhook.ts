import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { emailAccounts, webhookInbox, type Db } from '../../db/index.ts';
import { incrementalPull } from './incremental.ts';
import type { SyncEngineDeps } from './engine-deps.ts';

/**
 * Gmail push ingress + processing (CONTRACTS §C7 `/wh/gmail`, ARCHITECTURE §5).
 *
 * Persist-then-process (transactional inbox): the HTTP handler verifies the push,
 * stores the raw delivery in `webhook_inbox` keyed by the Pub/Sub `messageId`
 * (unique per provider), and fast-200s. A SEPARATE, idempotent step decodes the
 * notification, finds the mailbox, and drives an incremental pull — replaying a
 * delivery is safe because the inbox row is unique and processing is guarded on
 * `processed_at`.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

// --- Push envelope ----------------------------------------------------------

/** Inner Gmail notification (base64 in the Pub/Sub `message.data`). */
export const gmailNotificationSchema = z.object({
  emailAddress: z.string().min(1),
  historyId: z.union([z.string(), z.number()]).transform((v) => String(v)),
});
export type GmailNotification = z.infer<typeof gmailNotificationSchema>;

/** Pub/Sub push envelope POSTed to `/wh/gmail`. */
export const gmailPushSchema = z.object({
  message: z.object({
    data: z.string().min(1),
    messageId: z.string().min(1),
    publishTime: z.string().optional(),
  }),
  subscription: z.string().optional(),
});
export type GmailPush = z.infer<typeof gmailPushSchema>;

export interface ParsedGmailPush {
  /** Pub/Sub messageId — the `webhook_inbox` dedupe key. */
  eventId: string;
  notification: GmailNotification;
  /** The parsed envelope stored verbatim in `webhook_inbox.raw`. */
  envelope: GmailPush;
}

export class InvalidPushError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPushError';
  }
}

/** Parse + validate a raw push body into its event id and decoded notification. */
export function parseGmailPush(rawBody: string): ParsedGmailPush {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new InvalidPushError('push body is not JSON');
  }
  const envelope = gmailPushSchema.safeParse(json);
  if (!envelope.success) throw new InvalidPushError('push body is not a Pub/Sub envelope');

  let decoded: string;
  try {
    decoded = Buffer.from(envelope.data.message.data, 'base64').toString('utf8');
  } catch {
    throw new InvalidPushError('message.data is not base64');
  }
  let dataJson: unknown;
  try {
    dataJson = JSON.parse(decoded);
  } catch {
    throw new InvalidPushError('decoded notification is not JSON');
  }
  const notification = gmailNotificationSchema.safeParse(dataJson);
  if (!notification.success) throw new InvalidPushError('notification missing emailAddress/historyId');

  return {
    eventId: envelope.data.message.messageId,
    notification: notification.data,
    envelope: envelope.data,
  };
}

// --- Verification ------------------------------------------------------------

/**
 * Ingress verifier (CONTRACTS §C7: "signature-verified"). Real Gmail pushes carry
 * a Pub/Sub OIDC JWT in `Authorization`; the production adapter verifies it. This
 * seam lets the route verify without a compile-time branch on the adapter.
 */
export interface GmailPushVerifier {
  verify(headers: Record<string, string>, rawBody: string): boolean;
}

/**
 * Structural verifier for MOCK_MODE / tests. Rejects bodies that are not a valid
 * push envelope; optionally requires a shared token header to match (the mock
 * stand-in for signature verification). Never accepts malformed input.
 */
export class MockGmailPushVerifier implements GmailPushVerifier {
  private readonly requiredToken: string | undefined;
  private readonly tokenHeader: string;

  constructor(options: { requiredToken?: string; tokenHeader?: string } = {}) {
    this.requiredToken = options.requiredToken;
    this.tokenHeader = (options.tokenHeader ?? 'x-goog-channel-token').toLowerCase();
  }

  verify(headers: Record<string, string>, rawBody: string): boolean {
    try {
      parseGmailPush(rawBody);
    } catch {
      return false;
    }
    if (this.requiredToken === undefined) return true;
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
    return lower[this.tokenHeader] === this.requiredToken;
  }
}

// --- Persist (fast path) -----------------------------------------------------

export interface PersistResult {
  /** True iff this delivery was newly stored (false ⇒ duplicate messageId). */
  stored: boolean;
  inboxId: string | null;
}

/**
 * Persist a verified push into `webhook_inbox` (unique `provider_event_id`).
 * Duplicate deliveries conflict and no-op; the caller fast-200s regardless.
 */
export async function persistGmailPush(
  db: Db,
  parsed: ParsedGmailPush,
): Promise<PersistResult> {
  const inserted = await db
    .insert(webhookInbox)
    .values({
      provider: 'gmail',
      providerEventId: parsed.eventId,
      raw: parsed.envelope as unknown as Record<string, unknown>,
    })
    .onConflictDoNothing()
    .returning({ id: webhookInbox.id });
  const row = inserted[0];
  return { stored: row !== undefined, inboxId: row?.id ?? null };
}

// --- Process (separate idempotent step) --------------------------------------

export interface ProcessResult {
  /** Skipped because the inbox row was already processed. */
  alreadyProcessed: boolean;
  /** Account matched to the notification's address (null ⇒ unknown mailbox). */
  accountId: string | null;
  /** Whether an incremental pull was driven. */
  pulled: boolean;
}

/**
 * Process one `webhook_inbox` row idempotently: decode, resolve the mailbox by
 * address, drive an incremental pull, and stamp `processed_at`. Guarded on
 * `processed_at IS NULL` so a re-run is a no-op. Unknown mailbox / non-live
 * account is recorded (processed with an `error` note) rather than retried
 * forever.
 */
export async function processGmailInboxRow(
  deps: SyncEngineDeps,
  inboxId: string,
): Promise<ProcessResult> {
  const rows = await deps.db
    .select({
      id: webhookInbox.id,
      raw: webhookInbox.raw,
      processedAt: webhookInbox.processedAt,
    })
    .from(webhookInbox)
    .where(and(eq(webhookInbox.id, inboxId), eq(webhookInbox.provider, 'gmail')))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new InvalidPushError(`webhook_inbox row ${inboxId} not found`);
  if (row.processedAt !== null) return { alreadyProcessed: true, accountId: null, pulled: false };

  const parsed = parseGmailPush(JSON.stringify(row.raw));
  const accounts = await deps.db
    .select({ id: emailAccounts.id, status: emailAccounts.syncStatus })
    .from(emailAccounts)
    .where(eq(emailAccounts.address, parsed.notification.emailAddress))
    .limit(1);
  const account = accounts[0];

  let pulled = false;
  let errorNote: string | null = null;
  if (account === undefined) {
    errorNote = `no mailbox for ${parsed.notification.emailAddress}`;
  } else if (account.status === 'LIVE' || account.status === 'DEGRADED') {
    await incrementalPull(deps, account.id);
    pulled = true;
  } else {
    // Push arrived before backfill finished (or while re-auth pending): dedupe
    // makes it harmless to drop — the live-sync cursor will catch these adds.
    errorNote = `account not live (state=${account.status})`;
  }

  // Stamp processed_at once, guarded so a concurrent processor can't double-run.
  await deps.db
    .update(webhookInbox)
    .set({ processedAt: sql`now()`, error: errorNote, updatedAt: sql`now()` })
    .where(and(eq(webhookInbox.id, inboxId), isNull(webhookInbox.processedAt)));

  return { alreadyProcessed: false, accountId: account?.id ?? null, pulled };
}
