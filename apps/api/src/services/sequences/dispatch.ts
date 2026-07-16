import { createHash } from 'node:crypto';
import { and, eq, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { EmailProvider, OutboundEmail } from '@switchboard/shared/providers';
import {
  contacts,
  emailAccounts,
  leads,
  orgSettings,
  sendIntents,
  sequenceEnrollments,
  sequenceSteps,
  sequences,
  tasks,
  templates,
  users,
  type Db,
} from '../../db/index.ts';
import { recordActivity } from '../activity/index.ts';
import type { TokenCipher } from '../sync/token-cipher.ts';
import { renderTemplate, type MergeContext } from '../email/merge.ts';
import type { ProviderForAccount } from '../email/send.ts';
import { buildListUnsubscribeHeaders, type UnsubscribeHeaderConfig } from './unsubscribe.ts';
import { isEmailSuppressed } from './suppression.ts';
import {
  isInsideWindow,
  minutesUntilOpen,
  parseSendingWindow,
  resolveWindowTimezone,
} from './window.ts';
import { SEND_JOB_NAME, wakeupJobId } from './job-names.ts';
import type { QueueDriver } from '../../queue/index.ts';

/**
 * THE send transaction (task 2e, ARCHITECTURE §4.3, CONTRACTS §C6) — the ONLY
 * place a sequence step can send. Structure is verbatim to the design:
 *
 *   BEGIN;
 *     UPDATE send_intents SET state='CLAIMED' … WHERE state='SCHEDULED'
 *       AND due_at<=now() RETURNING *;         -- 0 rows → not ours / not due → bail
 *     SELECT enrollment … FOR UPDATE;          -- row lock serialises vs. pause
 *     re-check: enrollment active · not suppressed · not DNC · inside window ·
 *       under daily cap (counter incremented IN this txn);
 *     any check fails → SKIPPED / BLOCKED (reason) or DEFER, COMMIT, stop;
 *   COMMIT;                                     -- claim visible before any network call
 *   → provider.send(idempotencyKey = intent id) -- OUTSIDE the txn
 *   → re-lock enrollment; still active → SENT + sequence_step_sent; paused → SKIPPED
 *
 * Never-events secured here: I-SEND-1 (the `WHERE state='SCHEDULED'` claim + the
 * UNIQUE(enrollment_id,step_id) row ⇒ ≤1 SENT and ≤1 provider call per intent),
 * I-SEND-2 (enrollment row lock), I-SEND-3/I-DNC (suppression + DNC inside the
 * txn), I-SEND-4 (window + per-mailbox cap inside the txn). A crash between claim
 * and SENT leaves a CLAIMED row the sweeper expires to FAILED_TIMEOUT — never an
 * automatic re-send (idempotency key makes a manual retry safe too).
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export interface DispatchDeps {
  db: Db;
  providerFor: ProviderForAccount;
  cipher: TokenCipher;
  queue: QueueDriver;
  /** Distinguishes this worker in `send_intents.worker_id`. */
  workerId: string;
  now: () => Date;
  /** List-Unsubscribe header wiring (CONTRACTS §C6 I-SEND-5). */
  unsubscribe: UnsubscribeHeaderConfig;
}

export type DispatchResultKind =
  'sent' | 'skipped' | 'blocked' | 'deferred' | 'not_claimed' | 'failed' | 'paused_during_send';

export interface DispatchResult {
  kind: DispatchResultKind;
  intentId: string;
  reason?: string;
  providerMessageId?: string;
}

/** Optional per-step gate. Contract leaves `sequence_steps.condition` open; the
 *  one supported form is `{ skipIfReplied: true }` — skip if the contact replied
 *  since enrollment (matters only for a manually-resumed enrollment; a live reply
 *  already pauses). Unknown shapes are permissive (proceed). */
const stepConditionSchema = z
  .object({ skipIfReplied: z.boolean().optional() })
  .passthrough()
  .nullable();

const DEFAULT_DAILY_CAP = 200;

interface ClaimedContext {
  intentId: string;
  enrollmentId: string;
  leadId: string;
  contactId: string;
  stepId: string;
  channel: 'email' | 'call_task' | 'sms';
  emailAccountId: string | null;
  enrolledBy: string | null;
  sequenceId: string;
}

// --- Small loaders (run on the txn handle) ---------------------------------

interface OrgConfig {
  dailyCap: number;
  companyTimezone: string;
  sendingWindow: unknown;
}

async function loadOrgConfig(exec: Db): Promise<OrgConfig> {
  const rows = await exec
    .select({
      dailyCap: orgSettings.dailySendCap,
      companyTimezone: orgSettings.companyTimezone,
      sendingWindow: orgSettings.sendingWindow,
    })
    .from(orgSettings)
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return { dailyCap: DEFAULT_DAILY_CAP, companyTimezone: 'UTC', sendingWindow: null };
  }
  return {
    dailyCap: row.dailyCap,
    companyTimezone: row.companyTimezone,
    sendingWindow: row.sendingWindow,
  };
}

async function markTerminal(
  exec: Db,
  intentId: string,
  state: 'SKIPPED' | 'BLOCKED' | 'FAILED',
  reason: string,
): Promise<void> {
  await exec
    .update(sendIntents)
    .set({ state, skipReason: reason, updatedAt: sql`now()` })
    .where(eq(sendIntents.id, intentId));
}

/** Remaining non-terminal intents keep an enrollment open; zero ⇒ finished. */
async function finishIfComplete(
  exec: Db,
  enrollmentId: string,
  leadId: string,
  contactId: string,
  nowIso: string,
): Promise<void> {
  const remaining = await exec.execute(sql`
    SELECT 1 FROM send_intents
    WHERE enrollment_id = ${enrollmentId}
      AND state IN ('SCHEDULED', 'CLAIMED', 'AWAITING_REVIEW')
    LIMIT 1
  `);
  if ((remaining as { rows: unknown[] }).rows.length > 0) return;
  await exec
    .update(sequenceEnrollments)
    .set({ state: 'finished', updatedAt: sql`now()` })
    .where(and(eq(sequenceEnrollments.id, enrollmentId), eq(sequenceEnrollments.state, 'active')));
  await recordActivity(exec, {
    leadId,
    contactId,
    type: 'sequence_finished',
    occurredAt: nowIso,
    payload: { enrollmentId },
  });
}

function deterministicMessageId(accountId: string, intentId: string, address: string): string {
  const at = address.lastIndexOf('@');
  const domain = at >= 0 ? address.slice(at + 1) : 'switchboard.local';
  const hash = createHash('sha256')
    .update(`${accountId}|${intentId}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `<sb-seq-${hash}@${domain}>`;
}

// --- Phase A result -----------------------------------------------------------

interface EmailReadyPayload {
  kind: 'email_ready';
  ctx: ClaimedContext;
  address: string;
  provider: 'gmail' | 'mock';
  oauthTokens: string;
  draft: OutboundEmail;
  recipient: string;
}

type PhaseAOutcome = { kind: 'terminal'; result: DispatchResult } | EmailReadyPayload;

/**
 * Process one intent end-to-end. Idempotent by construction: a non-SCHEDULED /
 * not-due intent yields `not_claimed` (no side effects).
 */
export async function processIntent(deps: DispatchDeps, intentId: string): Promise<DispatchResult> {
  const now = deps.now();
  const nowIso = now.toISOString();

  const phaseA = await deps.db.transaction(async (txRaw): Promise<PhaseAOutcome> => {
    const tx = txRaw as Db;

    // 1. Claim: atomic guard — only a SCHEDULED, due intent is ours.
    const claimed = await tx
      .update(sendIntents)
      .set({ state: 'CLAIMED', claimedAt: nowIso, workerId: deps.workerId, updatedAt: sql`now()` })
      .where(
        and(
          eq(sendIntents.id, intentId),
          eq(sendIntents.state, 'SCHEDULED'),
          lte(sendIntents.dueAt, nowIso),
        ),
      )
      .returning({
        id: sendIntents.id,
        enrollmentId: sendIntents.enrollmentId,
        stepId: sendIntents.stepId,
        channel: sendIntents.channel,
      });
    const claim = claimed[0];
    if (claim === undefined) {
      return { kind: 'terminal', result: { kind: 'not_claimed', intentId } };
    }

    // 2. Row-lock the enrollment — serialises against a concurrent pause (I-SEND-2).
    const enrRows = await tx
      .select({
        id: sequenceEnrollments.id,
        state: sequenceEnrollments.state,
        leadId: sequenceEnrollments.leadId,
        contactId: sequenceEnrollments.contactId,
        emailAccountId: sequenceEnrollments.emailAccountId,
        enrolledBy: sequenceEnrollments.enrolledBy,
        sequenceId: sequenceEnrollments.sequenceId,
        createdAt: sequenceEnrollments.createdAt,
      })
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.id, claim.enrollmentId))
      .for('update');
    const enrollment = enrRows[0]!;

    const ctx: ClaimedContext = {
      intentId,
      enrollmentId: enrollment.id,
      leadId: enrollment.leadId,
      contactId: enrollment.contactId,
      stepId: claim.stepId,
      channel: claim.channel,
      emailAccountId: enrollment.emailAccountId,
      enrolledBy: enrollment.enrolledBy,
      sequenceId: enrollment.sequenceId,
    };

    // 3. Enrollment must be active (covers paused-by-reply/bounce/unsubscribe).
    if (enrollment.state !== 'active') {
      await markTerminal(tx, intentId, 'SKIPPED', `enrollment_${enrollment.state}`);
      return {
        kind: 'terminal',
        result: { kind: 'skipped', intentId, reason: `enrollment_${enrollment.state}` },
      };
    }

    if (claim.channel === 'sms') {
      // SMS-in-sequences is a documented v1 gap (DECISIONS D-034): the SMS send
      // engine (services/sms) exists and is rail-enforcing, but wiring sequence
      // dispatch to it (recipient-local quiet-hours per enrollment, opt-out state)
      // is deferred. Until then an SMS step is safely SKIPPED, never silently sent.
      await markTerminal(tx, intentId, 'SKIPPED', 'sms_channel_unavailable');
      return {
        kind: 'terminal',
        result: { kind: 'skipped', intentId, reason: 'sms_channel_unavailable' },
      };
    }

    if (claim.channel === 'call_task') {
      return {
        kind: 'terminal',
        result: await materializeCallTask(tx, ctx, nowIso),
      };
    }

    // --- Email channel: full compliance rails, all inside this txn -----------
    const stepRows = await tx
      .select({
        templateId: sequenceSteps.templateId,
        condition: sequenceSteps.condition,
      })
      .from(sequenceSteps)
      .where(eq(sequenceSteps.id, claim.stepId))
      .limit(1);
    const step = stepRows[0]!;

    // Condition gate (skipIfReplied).
    const condition = stepConditionSchema.parse(step.condition ?? null);
    if (condition?.skipIfReplied === true) {
      const replied = await tx.execute(sql`
        SELECT 1 FROM activities
        WHERE lead_id = ${ctx.leadId} AND type = 'email_received'
          AND occurred_at >= ${enrollment.createdAt}
        LIMIT 1
      `);
      if ((replied as { rows: unknown[] }).rows.length > 0) {
        await markTerminal(tx, intentId, 'SKIPPED', 'condition_skip_replied');
        return {
          kind: 'terminal',
          result: { kind: 'skipped', intentId, reason: 'condition_skip_replied' },
        };
      }
    }

    if (ctx.emailAccountId === null) {
      await markTerminal(tx, intentId, 'SKIPPED', 'no_email_account');
      return {
        kind: 'terminal',
        result: { kind: 'skipped', intentId, reason: 'no_email_account' },
      };
    }
    if (step.templateId === null) {
      await markTerminal(tx, intentId, 'SKIPPED', 'no_template');
      return { kind: 'terminal', result: { kind: 'skipped', intentId, reason: 'no_template' } };
    }

    // Load lead / contact / account / user.
    const leadRows = await tx
      .select({
        name: leads.name,
        url: leads.url,
        description: leads.description,
        custom: leads.custom,
        dnc: leads.dnc,
      })
      .from(leads)
      .where(and(eq(leads.id, ctx.leadId), sql`${leads.deletedAt} is null`))
      .limit(1);
    const lead = leadRows[0];
    if (lead === undefined) {
      await markTerminal(tx, intentId, 'SKIPPED', 'lead_not_found');
      return { kind: 'terminal', result: { kind: 'skipped', intentId, reason: 'lead_not_found' } };
    }

    const contactRows = await tx
      .select({
        name: contacts.name,
        title: contacts.title,
        emails: contacts.emails,
        phones: contacts.phones,
        dnc: contacts.dnc,
      })
      .from(contacts)
      .where(and(eq(contacts.id, ctx.contactId), sql`${contacts.deletedAt} is null`))
      .limit(1);
    const contact = contactRows[0];
    if (contact === undefined) {
      await markTerminal(tx, intentId, 'SKIPPED', 'contact_not_found');
      return {
        kind: 'terminal',
        result: { kind: 'skipped', intentId, reason: 'contact_not_found' },
      };
    }
    const recipient = contact.emails[0]?.email ?? null;
    if (recipient === null) {
      await markTerminal(tx, intentId, 'SKIPPED', 'no_recipient_email');
      return {
        kind: 'terminal',
        result: { kind: 'skipped', intentId, reason: 'no_recipient_email' },
      };
    }

    // I-DNC: lead + contact DNC inside the txn → BLOCKED (never an override prompt).
    if (lead.dnc) {
      await markTerminal(tx, intentId, 'BLOCKED', 'lead_dnc');
      return { kind: 'terminal', result: { kind: 'blocked', intentId, reason: 'lead_dnc' } };
    }
    if (contact.dnc) {
      await markTerminal(tx, intentId, 'BLOCKED', 'contact_dnc');
      return { kind: 'terminal', result: { kind: 'blocked', intentId, reason: 'contact_dnc' } };
    }

    // I-SEND-3: suppression inside the txn → BLOCKED.
    if (await isEmailSuppressed(tx, recipient)) {
      await markTerminal(tx, intentId, 'BLOCKED', 'suppressed');
      return { kind: 'terminal', result: { kind: 'blocked', intentId, reason: 'suppressed' } };
    }

    const org = await loadOrgConfig(tx);

    // I-SEND-4a: sending window (recipient-local, fallback company tz) → DEFER.
    const window = parseSendingWindow(org.sendingWindow);
    const tz = resolveWindowTimezone(window, null, org.companyTimezone);
    if (!isInsideWindow(now, window, tz)) {
      const deferMs = Math.max(60_000, minutesUntilOpen(now, window, tz) * 60_000);
      await deferIntent(tx, intentId, new Date(now.getTime() + deferMs).toISOString());
      return { kind: 'terminal', result: { kind: 'deferred', intentId, reason: 'outside_window' } };
    }

    // Account (address + tokens) — the mailbox this sequence sends from.
    const accountRows = await tx
      .select({
        address: emailAccounts.address,
        provider: emailAccounts.provider,
        oauthTokens: emailAccounts.oauthTokens,
        dailySendCount: emailAccounts.dailySendCount,
        dailyCountDate: emailAccounts.dailyCountDate,
      })
      .from(emailAccounts)
      .where(eq(emailAccounts.id, ctx.emailAccountId))
      .for('update');
    const account = accountRows[0];
    if (account === undefined || account.oauthTokens === null) {
      await markTerminal(tx, intentId, 'SKIPPED', 'account_unlinked');
      return {
        kind: 'terminal',
        result: { kind: 'skipped', intentId, reason: 'account_unlinked' },
      };
    }

    // I-SEND-4b: per-mailbox daily cap — counter incremented INSIDE this txn.
    const today = nowIso.slice(0, 10); // UTC calendar day (sessions pinned to UTC)
    const usedToday = account.dailyCountDate === today ? account.dailySendCount : 0;
    if (usedToday >= org.dailyCap) {
      // Defer to the next UTC day (cap resets); keep the intent schedulable.
      const nextDay = new Date(now.getTime() + 24 * 3_600_000).toISOString();
      await deferIntent(tx, intentId, nextDay);
      return { kind: 'terminal', result: { kind: 'deferred', intentId, reason: 'cap_exceeded' } };
    }
    await tx
      .update(emailAccounts)
      .set({ dailySendCount: usedToday + 1, dailyCountDate: today, updatedAt: sql`now()` })
      .where(eq(emailAccounts.id, ctx.emailAccountId));

    // Render (merge tags) + build the outbound draft with List-Unsubscribe.
    // Direct load: a sequence send is a SYSTEM action, not a user browsing
    // templates, so it bypasses the owner/shared visibility gate.
    const templateRows = await tx
      .select({ subject: templates.subject, body: templates.body })
      .from(templates)
      .where(eq(templates.id, step.templateId))
      .limit(1);
    const template = templateRows[0];
    if (template === undefined) {
      await markTerminal(tx, intentId, 'SKIPPED', 'template_not_found');
      return {
        kind: 'terminal',
        result: { kind: 'skipped', intentId, reason: 'template_not_found' },
      };
    }
    let user: { name: string; email: string } | null = null;
    if (ctx.enrolledBy !== null) {
      const userRows = await tx
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, ctx.enrolledBy))
        .limit(1);
      user = userRows[0] ?? null;
    }
    const mergeCtx: MergeContext = {
      lead: { name: lead.name, url: lead.url, description: lead.description, custom: lead.custom },
      contact: {
        name: contact.name,
        title: contact.title,
        email: recipient,
        phone: contact.phones[0]?.phone ?? null,
      },
      user,
    };
    const rendered = renderTemplate({ subject: template.subject, body: template.body }, mergeCtx, {
      format: 'text',
    });

    const messageId = deterministicMessageId(ctx.emailAccountId, intentId, account.address);
    const unsubHeaders = buildListUnsubscribeHeaders(deps.unsubscribe, recipient);
    const draft: OutboundEmail = {
      to: [recipient],
      subject: rendered.subject ?? '',
      bodyText: rendered.body,
      headers: { 'Message-ID': messageId, ...unsubHeaders },
    };

    // Claim + cap increment commit here; the provider call happens OUTSIDE the txn.
    return {
      kind: 'email_ready',
      ctx,
      address: account.address,
      provider: account.provider,
      oauthTokens: account.oauthTokens,
      draft,
      recipient,
    };
  });

  if (phaseA.kind === 'terminal') return phaseA.result;

  // --- Phase B: provider.send OUTSIDE the transaction (idempotencyKey=intentId).
  const provider: EmailProvider = deps.providerFor({
    address: phaseA.address,
    provider: phaseA.provider,
  });
  const tokens = deps.cipher.decrypt(phaseA.oauthTokens);
  let providerMessageId: string;
  try {
    const res = await provider.send(tokens, phaseA.draft, intentId);
    providerMessageId = res.providerMessageId;
  } catch (err) {
    await deps.db.transaction(async (txRaw) => {
      await markTerminal(
        txRaw as Db,
        intentId,
        'FAILED',
        err instanceof Error ? err.message : String(err),
      );
    });
    return { kind: 'failed', intentId, reason: 'provider_error' };
  }

  // --- Phase C: mark SENT — re-lock the enrollment; a pause landed during the
  // network window (I-SEND-2 "during the claim window") wins: no SENT after pause.
  return deps.db.transaction(async (txRaw): Promise<DispatchResult> => {
    const tx = txRaw as Db;
    const enrRows = await tx
      .select({ state: sequenceEnrollments.state })
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.id, phaseA.ctx.enrollmentId))
      .for('update');
    if (enrRows[0]!.state !== 'active') {
      await markTerminal(tx, intentId, 'SKIPPED', 'paused_during_send');
      return { kind: 'paused_during_send', intentId, reason: 'paused_during_send' };
    }
    await tx
      .update(sendIntents)
      .set({ state: 'SENT', sentAt: nowIso, providerMessageId, updatedAt: sql`now()` })
      .where(eq(sendIntents.id, intentId));
    await recordActivity(tx, {
      leadId: phaseA.ctx.leadId,
      contactId: phaseA.ctx.contactId,
      ...(phaseA.ctx.enrolledBy !== null ? { userId: phaseA.ctx.enrolledBy } : {}),
      type: 'sequence_step_sent',
      occurredAt: nowIso,
      payload: {
        enrollmentId: phaseA.ctx.enrollmentId,
        stepId: phaseA.ctx.stepId,
        channel: 'email',
      },
    });
    await finishIfComplete(
      tx,
      phaseA.ctx.enrollmentId,
      phaseA.ctx.leadId,
      phaseA.ctx.contactId,
      nowIso,
    );
    return { kind: 'sent', intentId, providerMessageId };
  });
}

/** Reset a claimed intent back to SCHEDULED with a later due time and re-enqueue. */
async function deferIntent(exec: Db, intentId: string, dueIso: string): Promise<void> {
  await exec
    .update(sendIntents)
    .set({
      state: 'SCHEDULED',
      claimedAt: null,
      workerId: null,
      dueAt: dueIso,
      updatedAt: sql`now()`,
    })
    .where(eq(sendIntents.id, intentId));
}

/** call_task step: create a follow-up task, emit task_created, complete the step. */
async function materializeCallTask(
  exec: Db,
  ctx: ClaimedContext,
  nowIso: string,
): Promise<DispatchResult> {
  const seqRows = await exec
    .select({ name: sequences.name })
    .from(sequences)
    .where(eq(sequences.id, ctx.sequenceId))
    .limit(1);
  const seqName = seqRows[0]?.name ?? 'Sequence';
  const leadRows = await exec
    .select({ name: leads.name })
    .from(leads)
    .where(and(eq(leads.id, ctx.leadId), sql`${leads.deletedAt} is null`))
    .limit(1);
  if (leadRows[0] === undefined) {
    await markTerminal(exec, ctx.intentId, 'SKIPPED', 'lead_not_found');
    return { kind: 'skipped', intentId: ctx.intentId, reason: 'lead_not_found' };
  }

  const taskRows = await exec
    .insert(tasks)
    .values({
      leadId: ctx.leadId,
      ...(ctx.enrolledBy !== null ? { assigneeId: ctx.enrolledBy, createdBy: ctx.enrolledBy } : {}),
      title: `${seqName}: call ${leadRows[0].name}`,
      dueAt: nowIso,
    })
    .returning({ id: tasks.id });
  const taskId = taskRows[0]!.id;

  await exec
    .update(sendIntents)
    .set({ state: 'SENT', sentAt: nowIso, updatedAt: sql`now()` })
    .where(eq(sendIntents.id, ctx.intentId));

  await recordActivity(exec, {
    leadId: ctx.leadId,
    contactId: ctx.contactId,
    ...(ctx.enrolledBy !== null ? { userId: ctx.enrolledBy } : {}),
    type: 'task_created',
    occurredAt: nowIso,
    payload: { taskId, dueAt: nowIso, title: `${seqName}: call ${leadRows[0].name}` },
  });
  await finishIfComplete(exec, ctx.enrollmentId, ctx.leadId, ctx.contactId, nowIso);
  return { kind: 'sent', intentId: ctx.intentId };
}

/** Re-enqueue a wake-up for a deferred intent (window/cap). Called post-commit. */
export async function requeueDeferred(deps: DispatchDeps, intentId: string): Promise<void> {
  const rows = await deps.db
    .select({ dueAt: sendIntents.dueAt, state: sendIntents.state })
    .from(sendIntents)
    .where(eq(sendIntents.id, intentId))
    .limit(1);
  const row = rows[0];
  if (row === undefined || row.state !== 'SCHEDULED') return;
  const delayMs = Math.max(0, new Date(row.dueAt).getTime() - deps.now().getTime());
  await deps.queue.enqueue(SEND_JOB_NAME, { intentId }, { delayMs, jobId: wakeupJobId(intentId) });
}
