import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db } from '../../db/index.ts';
import { recordActivity } from '../activity/index.ts';
import { contactsWithEmail, pauseActiveEnrollments } from './pause.ts';
import { addEmailSuppression } from './suppression.ts';

/**
 * Unsubscribe engine (CONTRACTS §C6 I-SEND-5). Every sequence email carries
 * `List-Unsubscribe` headers (mailto + one-click https); hitting EITHER path lands
 * here and, in one transaction:
 *   1. adds a GLOBAL email suppression (source `unsubscribe`);
 *   2. emits `unsubscribed` + `suppression_added` on each affected lead's timeline;
 *   3. pauses those contacts' active enrollments (reason `unsubscribe`, which emits
 *      `sequence_paused`).
 *
 * All timeline events fire exactly once — they are emitted only when the
 * suppression is newly created/re-activated, so a repeat click is a safe no-op
 * (CONTRACTS §C4 exactly-once).
 *
 * The one-click token is a stateless HMAC over the recipient address, so the
 * `List-Unsubscribe` header is deterministic (idempotent) and needs no stored
 * token row. No secret material or PII rides in the URL beyond the opaque address
 * token the recipient already owns.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

// --- One-click token (RFC 8058 https path) ---------------------------------

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/** Deterministic opaque token binding `email` under `secret`. */
export function createUnsubscribeToken(secret: string, email: string): string {
  const payload = b64url(Buffer.from(email.toLowerCase(), 'utf8'));
  const mac = b64url(createHmac('sha256', secret).update(payload).digest());
  return `${payload}.${mac}`;
}

/** Verify a token; returns the bound (lowercased) email or null if invalid. */
export function verifyUnsubscribeToken(secret: string, token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, mac] = parts;
  const expected = b64url(createHmac('sha256', secret).update(payload!).digest());
  const a = Buffer.from(mac!, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return Buffer.from(payload!, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Build the two `List-Unsubscribe` header values for a sequence email
 * (CONTRACTS §C6 I-SEND-5): a `mailto:` and a one-click `https` URL, plus the
 * RFC 8058 `List-Unsubscribe-Post` value.
 */
export interface UnsubscribeHeaderConfig {
  /** Absolute base URL of the API (e.g. `https://app.example.com`). */
  baseUrl: string;
  /** Address the mailto path routes to (e.g. `unsubscribe@example.com`). */
  mailbox: string;
  secret: string;
}

export function buildListUnsubscribeHeaders(
  config: UnsubscribeHeaderConfig,
  recipient: string,
): Record<string, string> {
  const token = createUnsubscribeToken(config.secret, recipient);
  const httpsUrl = `${config.baseUrl.replace(/\/$/, '')}/api/v1/unsubscribe/${token}`;
  const mailto = `mailto:${config.mailbox}?subject=unsubscribe&body=${encodeURIComponent(recipient)}`;
  return {
    'List-Unsubscribe': `<${mailto}>, <${httpsUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

// --- The suppression action -------------------------------------------------

export interface ApplyUnsubscribeInput {
  email: string;
  /** Defaults to `unsubscribe`; `stop_keyword` covered by the SMS path. */
  source?: 'unsubscribe' | 'manual';
  createdBy?: string;
}

export interface ApplyUnsubscribeResult {
  suppressionId: string;
  /** True iff this call newly created/re-activated the suppression. */
  changed: boolean;
  pausedEnrollmentIds: string[];
  affectedLeadIds: string[];
}

export async function applyUnsubscribe(
  db: Db,
  input: ApplyUnsubscribeInput,
): Promise<ApplyUnsubscribeResult> {
  const email = input.email.trim();
  const source = input.source ?? 'unsubscribe';

  return db.transaction(async (txRaw) => {
    const tx = txRaw as Db;
    const add = await addEmailSuppression(tx, {
      value: email,
      source,
      reason: 'recipient unsubscribed',
      ...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {}),
    });

    const targets = await contactsWithEmail(tx, email);
    const leadIds = [...new Set(targets.map((t) => t.leadId))];

    // Timeline events exactly once — only on the newly-active suppression.
    if (add.created) {
      const nowIso = new Date().toISOString();
      for (const leadId of leadIds) {
        await recordActivity(tx, {
          leadId,
          type: 'unsubscribed',
          occurredAt: nowIso,
          payload: { value: email },
        });
        await recordActivity(tx, {
          leadId,
          type: 'suppression_added',
          occurredAt: nowIso,
          payload: { suppressionId: add.suppressionId, kind: 'email', value: email, source },
        });
      }
    }

    const pausedEnrollmentIds: string[] = [];
    for (const target of targets) {
      const ids = await pauseActiveEnrollments(
        tx,
        { leadId: target.leadId, contactId: target.contactId },
        'unsubscribe',
      );
      pausedEnrollmentIds.push(...ids);
    }

    return {
      suppressionId: add.suppressionId,
      changed: add.created,
      pausedEnrollmentIds,
      affectedLeadIds: leadIds,
    };
  });
}
