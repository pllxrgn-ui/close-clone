import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type {
  EmailProvider,
  OutboundEmail,
  RawEmail,
  SendResult,
} from '@switchboard/shared/providers';
import {
  contacts,
  emailAccounts,
  emailMessages,
  emailThreads,
  leads,
  users,
  type Db,
} from '../../db/index.ts';
import type { TokenCipher } from '../sync/token-cipher.ts';
import { assertActiveUser } from '../templates/access.ts';
import { getTemplate } from '../templates/index.ts';
import { materializeThreadActivities } from './activities.ts';
import type { ActivityWebhookEmitter } from '../activity/index.ts';
import { renderTemplate, type MergeContext } from './merge.ts';
import { resolveThreadForMessage } from './threading.ts';

/**
 * One-off send engine (task 2d) — THE only path to `EmailProvider.send` for
 * one-off mail (ARCHITECTURE §1: compliance rails live in the engine, so the REST
 * API cannot bypass them). The route is a thin translator; every rail below runs
 * here, at execution time:
 *
 *   1. merge-tag render (unresolved required tag → VALIDATION_FAILED, never raw
 *      braces on the wire);
 *   2. suppression + contact/lead DNC checks BEFORE the provider call
 *      (CONTRACTS §C6 I-DNC / §C8 SUPPRESSED — never an override prompt);
 *   3. per-account send-from — the sending rep's OWN mailbox address is the From /
 *      Message-ID identity, using that account's decrypted tokens + provider
 *      instance (resolving the 2b note);
 *   4. persistence into `email_messages`/`email_threads` consistent with 2c
 *      threading (a reply threads onto its parent's thread), writing exactly one
 *      `email_sent` activity via the ActivityWriter (`materializeThreadActivities`).
 *
 * Idempotency: a client `idempotencyKey` derives a deterministic `Message-ID`; a
 * repeat send short-circuits (no second provider call, no second activity). The
 * unique `(account_id, rfc_message_id)` index is the concurrent-race backstop.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

// --- Errors (mapped to C8 codes at the route) ------------------------------

export class SendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SendError';
  }
}

/** Suppression or contact/lead DNC hit at execution time → C8 SUPPRESSED (422). */
export class SuppressedError extends SendError {
  readonly reason: 'suppressed' | 'lead_dnc' | 'contact_dnc';
  readonly value: string;
  constructor(reason: 'suppressed' | 'lead_dnc' | 'contact_dnc', value: string) {
    super(
      reason === 'suppressed'
        ? `recipient ${value} is suppressed`
        : reason === 'lead_dnc'
          ? `lead ${value} is marked do-not-contact`
          : `contact ${value} is marked do-not-contact`,
    );
    this.name = 'SuppressedError';
    this.reason = reason;
    this.value = value;
  }
}

/** Bad request shape the route's zod did not catch (business rule) → 400. */
export class SendValidationError extends SendError {
  constructor(message: string) {
    super(message);
    this.name = 'SendValidationError';
  }
}

export class SendAccountNotFoundError extends SendError {
  readonly accountId: string;
  constructor(accountId: string) {
    super(`email account ${accountId} not found`);
    this.name = 'SendAccountNotFoundError';
    this.accountId = accountId;
  }
}

/** The account exists but is not linked (no tokens) → 409. */
export class SendAccountNotLinkedError extends SendError {
  readonly accountId: string;
  constructor(accountId: string) {
    super(`email account ${accountId} is not linked (no credentials)`);
    this.name = 'SendAccountNotLinkedError';
    this.accountId = accountId;
  }
}

export class SendLeadNotFoundError extends SendError {
  readonly leadId: string;
  constructor(leadId: string) {
    super(`lead ${leadId} not found or soft-deleted`);
    this.name = 'SendLeadNotFoundError';
    this.leadId = leadId;
  }
}

export class SendContactNotFoundError extends SendError {
  readonly contactId: string;
  constructor(contactId: string) {
    super(`contact ${contactId} not found or soft-deleted`);
    this.name = 'SendContactNotFoundError';
    this.contactId = contactId;
  }
}

/** A reply's thread is already matched to a DIFFERENT lead → 409. */
export class SendThreadConflictError extends SendError {
  constructor(threadId: string, existing: string | null, requested: string) {
    super(
      `thread ${threadId} is matched to lead ${existing}; cannot log a send under ${requested}`,
    );
    this.name = 'SendThreadConflictError';
  }
}

/** The underlying provider send failed → C8 PROVIDER_ERROR (502). */
export class SendProviderError extends SendError {
  constructor(message: string) {
    super(`provider send failed: ${message}`);
    this.name = 'SendProviderError';
  }
}

// --- Public shape ----------------------------------------------------------

export type ProviderForAccount = (identity: {
  address: string;
  provider: 'gmail' | 'mock';
}) => EmailProvider;

export interface SendServiceDeps {
  db: Db;
  /** Per-account send-from: an EmailProvider bound to the mailbox's address. */
  providerFor: ProviderForAccount;
  /** Decrypts `email_accounts.oauth_tokens`. */
  cipher: TokenCipher;
  /** Fans email_sent onto activity.recorded webhooks. */
  emitter?: ActivityWebhookEmitter;
}

export interface SendOneOffInput {
  /** The rep performing the send (user merge context + template visibility). */
  actorId: string;
  /** The sending mailbox (per-account send-from). */
  accountId: string;
  /** Timeline target + lead merge context. */
  leadId: string;
  /** Recipient contact — DNC + merge context; its primary email defaults `to`. */
  contactId?: string;
  /** Explicit recipients (default: the contact's primary email). */
  to?: string[];
  cc?: string[];
  /** Inline subject/body (ignored when `templateId` is given). */
  subject?: string;
  body?: string;
  /** Render subject/body from a template the actor can see. */
  templateId?: string;
  /** Client key for safe retries (same key ⇒ one send, one activity). */
  idempotencyKey?: string;
  /** The `email_messages.id` being replied to (reply-from-CRM threads correctly). */
  inReplyToMessageId?: string;
}

export interface SendOneOffResult {
  messageId: string;
  threadId: string;
  leadId: string;
  providerMessageId: string;
  rfcMessageId: string;
  /** True iff a prior send with the same idempotency key already delivered this. */
  deduped: boolean;
}

// --- Loads -----------------------------------------------------------------

interface AccountCtx {
  id: string;
  address: string;
  provider: 'gmail' | 'mock';
  oauthTokens: string;
}

async function loadAccount(db: Db, accountId: string): Promise<AccountCtx> {
  const rows = await db
    .select({
      id: emailAccounts.id,
      address: emailAccounts.address,
      provider: emailAccounts.provider,
      oauthTokens: emailAccounts.oauthTokens,
    })
    .from(emailAccounts)
    .where(eq(emailAccounts.id, accountId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new SendAccountNotFoundError(accountId);
  if (row.oauthTokens === null) throw new SendAccountNotLinkedError(accountId);
  return { id: row.id, address: row.address, provider: row.provider, oauthTokens: row.oauthTokens };
}

interface LeadCtx {
  name: string;
  url: string | null;
  description: string | null;
  custom: Record<string, unknown>;
  dnc: boolean;
}

async function loadLead(db: Db, leadId: string): Promise<LeadCtx> {
  const rows = await db
    .select({
      name: leads.name,
      url: leads.url,
      description: leads.description,
      custom: leads.custom,
      dnc: leads.dnc,
    })
    .from(leads)
    .where(and(eq(leads.id, leadId), sql`${leads.deletedAt} is null`))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new SendLeadNotFoundError(leadId);
  return row;
}

interface UserCtx {
  name: string;
  email: string;
}

async function loadUser(db: Db, userId: string): Promise<UserCtx> {
  const rows = await db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new SendValidationError(`user ${userId} not found`);
  return row;
}

interface ContactCtx {
  id: string;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  dnc: boolean;
}

async function loadContact(db: Db, contactId: string, leadId: string): Promise<ContactCtx> {
  const rows = await db
    .select({
      id: contacts.id,
      leadId: contacts.leadId,
      name: contacts.name,
      title: contacts.title,
      emails: contacts.emails,
      phones: contacts.phones,
      dnc: contacts.dnc,
    })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), sql`${contacts.deletedAt} is null`))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new SendContactNotFoundError(contactId);
  if (row.leadId !== leadId) {
    throw new SendValidationError(`contact ${contactId} does not belong to lead ${leadId}`);
  }
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    email: row.emails[0]?.email ?? null,
    phone: row.phones[0]?.phone ?? null,
    dnc: row.dnc,
  };
}

interface ParentMessage {
  rfcMessageId: string | null;
  refs: string[];
}

async function loadParentMessage(db: Db, messageId: string): Promise<ParentMessage> {
  const rows = await db
    .select({ rfcMessageId: emailMessages.rfcMessageId, refs: emailMessages.refs })
    .from(emailMessages)
    .where(eq(emailMessages.id, messageId))
    .limit(1);
  const row = rows[0];
  if (row === undefined)
    throw new SendValidationError(`reply target message ${messageId} not found`);
  return {
    rfcMessageId: row.rfcMessageId,
    refs: (row.refs as unknown[]).filter((r): r is string => typeof r === 'string'),
  };
}

// --- Helpers ---------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

function normalizeRecipients(list: string[]): string[] {
  const cleaned = list.map((e) => e.trim()).filter((e) => e.length > 0);
  for (const e of cleaned) {
    if (!EMAIL_RE.test(e)) throw new SendValidationError(`invalid recipient address: ${e}`);
  }
  return [...new Set(cleaned)];
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.length > 0))];
}

function deriveSnippet(body: string): string {
  return body.slice(0, 200);
}

function textArray(values: string[]): ReturnType<typeof sql> {
  if (values.length === 0) return sql`ARRAY[]::text[]`;
  return sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;
}

/** Deterministic RFC Message-ID for an (account, idempotency key) pair. */
function deterministicMessageId(accountId: string, key: string, address: string): string {
  const at = address.lastIndexOf('@');
  const domain = at >= 0 ? address.slice(at + 1) : 'switchboard.local';
  const hash = createHash('sha256')
    .update(`${accountId}|${key}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `<sb-${hash}@${domain}>`;
}

/** The first recipient that has an ACTIVE email suppression, else null (CI). */
async function firstSuppressedRecipient(db: Db, recipients: string[]): Promise<string | null> {
  if (recipients.length === 0) return null;
  const result = await db.execute(sql`
    SELECT lower(value::text) AS v
    FROM suppressions
    WHERE kind = 'email'
      AND released_at IS NULL
      AND value = ANY(${textArray(recipients)}::citext[])
  `);
  const rows = (result as { rows: Record<string, unknown>[] }).rows;
  if (rows.length === 0) return null;
  const hit = new Set(rows.map((r) => String(r['v'])));
  for (const r of recipients) {
    if (hit.has(r.toLowerCase())) return r;
  }
  return null;
}

interface ExistingSend {
  id: string;
  threadId: string | null;
  leadId: string | null;
  providerMessageId: string | null;
}

async function findByRfc(exec: Db, accountId: string, rfc: string): Promise<ExistingSend | null> {
  const rows = await exec
    .select({
      id: emailMessages.id,
      threadId: emailMessages.threadId,
      providerMessageId: emailMessages.providerMessageId,
      leadId: emailThreads.leadId,
    })
    .from(emailMessages)
    .leftJoin(emailThreads, eq(emailMessages.threadId, emailThreads.id))
    .where(and(eq(emailMessages.accountId, accountId), eq(emailMessages.rfcMessageId, rfc)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    threadId: row.threadId,
    leadId: row.leadId,
    providerMessageId: row.providerMessageId,
  };
}

/** Attach the thread to the explicitly-chosen lead (matched); conflict if it is
 *  already matched to a different lead. Ambiguous/ignored threads are attached —
 *  the rep's deliberate send from the lead's context is a stronger signal than
 *  inference. */
async function attachThreadToLead(exec: Db, threadId: string, leadId: string): Promise<void> {
  const rows = await exec
    .select({ triageStatus: emailThreads.triageStatus, leadId: emailThreads.leadId })
    .from(emailThreads)
    .where(eq(emailThreads.id, threadId))
    .limit(1);
  const thread = rows[0];
  if (thread === undefined) throw new SendError(`thread ${threadId} vanished during send`);
  if (thread.triageStatus === 'matched') {
    if (thread.leadId === leadId) return;
    throw new SendThreadConflictError(threadId, thread.leadId, leadId);
  }
  await exec
    .update(emailThreads)
    .set({ triageStatus: 'matched', leadId, updatedAt: sql`now()` })
    .where(eq(emailThreads.id, threadId));
}

interface PersistInput {
  accountId: string;
  leadId: string;
  address: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  providerMessageId: string;
  rfcMessageId: string;
  inReplyTo?: string;
  references: string[];
}

async function persistSent(
  db: Db,
  p: PersistInput,
  emitter?: ActivityWebhookEmitter,
): Promise<SendOneOffResult> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as Db;
    const nowIso = new Date().toISOString();

    const inserted = await tx
      .insert(emailMessages)
      .values({
        accountId: p.accountId,
        providerMessageId: p.providerMessageId,
        rfcMessageId: p.rfcMessageId,
        threadId: null,
        direction: 'out',
        fromAddr: p.address,
        toAddrs: p.to,
        cc: p.cc,
        subject: p.subject,
        snippet: deriveSnippet(p.body),
        bodyRef: null,
        sentAt: nowIso,
        inReplyTo: p.inReplyTo ?? null,
        refs: p.references,
      })
      // Target the rfc uniqueness specifically: a same-key concurrent race
      // (identical deterministic Message-ID) dedups here; a provider-message-id
      // clash is a genuine anomaly and is left to raise.
      .onConflictDoNothing({ target: [emailMessages.accountId, emailMessages.rfcMessageId] })
      .returning({ id: emailMessages.id });

    const insertedRow = inserted[0];
    if (insertedRow === undefined) {
      // Concurrent race: another call already persisted this rfc. No new activity.
      const existing = await findByRfc(tx, p.accountId, p.rfcMessageId);
      if (existing === null) throw new SendError('send conflict but no message row found');
      return {
        messageId: existing.id,
        threadId: existing.threadId ?? '',
        leadId: existing.leadId ?? p.leadId,
        providerMessageId: existing.providerMessageId ?? p.providerMessageId,
        rfcMessageId: p.rfcMessageId,
        deduped: true,
      };
    }

    const messageId = insertedRow.id;
    const raw: RawEmail = {
      providerMessageId: p.providerMessageId,
      rfcMessageId: p.rfcMessageId,
      threadId: '',
      historyId: '0',
      direction: 'out',
      from: p.address,
      to: p.to,
      cc: p.cc,
      subject: p.subject,
      snippet: deriveSnippet(p.body),
      references: p.references,
      headers: { 'Message-ID': p.rfcMessageId },
      labels: ['SENT'],
      sentAt: nowIso,
      ...(p.inReplyTo !== undefined ? { inReplyTo: p.inReplyTo } : {}),
    };

    const threadId = await resolveThreadForMessage(tx, p.accountId, messageId, raw);
    await attachThreadToLead(tx, threadId, p.leadId);
    await materializeThreadActivities(tx, threadId, p.leadId, emitter);

    return {
      messageId,
      threadId,
      leadId: p.leadId,
      providerMessageId: p.providerMessageId,
      rfcMessageId: p.rfcMessageId,
      deduped: false,
    };
  });
}

// --- The engine ------------------------------------------------------------

export async function sendOneOff(
  deps: SendServiceDeps,
  input: SendOneOffInput,
): Promise<SendOneOffResult> {
  const { db } = deps;

  await assertActiveUser(db, input.actorId);
  const account = await loadAccount(db, input.accountId);
  const lead = await loadLead(db, input.leadId);
  const user = await loadUser(db, input.actorId);
  const contact =
    input.contactId === undefined ? null : await loadContact(db, input.contactId, input.leadId);

  // Subject/body source: template (visible to actor, email channel) or inline.
  let subjectTemplate: string | null;
  let bodyTemplate: string;
  if (input.templateId !== undefined) {
    const template = await getTemplate(db, input.templateId, input.actorId);
    if (template.channel !== 'email') {
      throw new SendValidationError(`template ${template.id} is not an email template`);
    }
    subjectTemplate = template.subject;
    bodyTemplate = template.body;
  } else {
    subjectTemplate = input.subject ?? null;
    if (input.body === undefined || input.body.length === 0) {
      throw new SendValidationError('body is required when no template is given');
    }
    bodyTemplate = input.body;
  }

  // Merge render (unresolved required tag → MergeRenderError → VALIDATION_FAILED).
  const mergeContext: MergeContext = {
    lead: { name: lead.name, url: lead.url, description: lead.description, custom: lead.custom },
    contact:
      contact === null
        ? null
        : { name: contact.name, title: contact.title, email: contact.email, phone: contact.phone },
    user: { name: user.name, email: user.email },
  };
  const rendered = renderTemplate({ subject: subjectTemplate, body: bodyTemplate }, mergeContext, {
    format: 'text',
  });

  const to = normalizeRecipients(input.to ?? (contact?.email ? [contact.email] : []));
  if (to.length === 0) throw new SendValidationError('at least one recipient is required');
  const cc = normalizeRecipients(input.cc ?? []);

  // Compliance rails — I-DNC + suppression, at execution time, in the engine.
  if (lead.dnc) throw new SuppressedError('lead_dnc', input.leadId);
  if (contact !== null && contact.dnc) throw new SuppressedError('contact_dnc', contact.id);
  const suppressed = await firstSuppressedRecipient(db, [...to, ...cc]);
  if (suppressed !== null) throw new SuppressedError('suppressed', suppressed);

  // Reply threading headers (reply-from-CRM).
  let inReplyTo: string | undefined;
  let references: string[] = [];
  if (input.inReplyToMessageId !== undefined) {
    const parent = await loadParentMessage(db, input.inReplyToMessageId);
    if (parent.rfcMessageId !== null) {
      inReplyTo = parent.rfcMessageId;
      references = dedupe([...parent.refs, parent.rfcMessageId]);
    }
  }

  // Idempotency: deterministic Message-ID; a prior completed send short-circuits.
  const key = input.idempotencyKey ?? randomUUID();
  const detRfcId = deterministicMessageId(input.accountId, key, account.address);
  const prior = await findByRfc(db, input.accountId, detRfcId);
  if (prior !== null) {
    return {
      messageId: prior.id,
      threadId: prior.threadId ?? '',
      leadId: prior.leadId ?? input.leadId,
      providerMessageId: prior.providerMessageId ?? '',
      rfcMessageId: detRfcId,
      deduped: true,
    };
  }

  const draft: OutboundEmail = {
    to,
    subject: rendered.subject ?? '',
    bodyText: rendered.body,
    headers: { 'Message-ID': detRfcId },
    ...(cc.length > 0 ? { cc } : {}),
    ...(inReplyTo !== undefined ? { inReplyTo } : {}),
    ...(references.length > 0 ? { references } : {}),
  };

  const tokens = deps.cipher.decrypt(account.oauthTokens);
  let result: SendResult;
  try {
    const provider = deps.providerFor({ address: account.address, provider: account.provider });
    result = await provider.send(tokens, draft, key);
  } catch (err) {
    throw new SendProviderError(err instanceof Error ? err.message : String(err));
  }

  return persistSent(
    db,
    {
      accountId: input.accountId,
      leadId: input.leadId,
      address: account.address,
      to,
      cc,
      subject: rendered.subject ?? '',
      body: rendered.body,
      providerMessageId: result.providerMessageId,
      rfcMessageId: result.rfcMessageId,
      references,
      ...(inReplyTo !== undefined ? { inReplyTo } : {}),
    },
    deps.emitter,
  );
}
