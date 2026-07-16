import { eq, sql } from 'drizzle-orm';

import { webhookDeliveries, webhookSubscriptions, type Db } from '../../db/index.ts';
import type { JobProcessor, QueueDriver, QueueJob } from '../../queue/index.ts';
import { redactSnapshot } from '../audit/index.ts';
import {
  DEFAULT_BACKOFF,
  isDeadLettered,
  nextRetryDelayMs,
  type BackoffConfig,
} from './backoff.ts';
import { SIGNATURE_HEADER, buildSignatureHeader } from './signing.ts';
import { WEBHOOK_DELIVERY_JOB, webhookDeliveryJobId } from './job-names.ts';

/**
 * Outbound webhook delivery worker (Task 5c, ARCHITECTURE §5). Processes ONE
 * `webhook_deliveries` row: signs the stored envelope (HMAC-SHA256), POSTs it via
 * an injected {@link WebhookSender} (real `fetch` in prod; a fake in tests — no
 * network under MOCK_MODE), and advances the ledger:
 *
 *   2xx                         → `delivered`   (terminal)
 *   failure, retries remain     → `pending`     (attempts++, next_retry_at set,
 *                                                 re-enqueued with backoff+jitter)
 *   failure, attempts exhausted → `failed`      (terminal — the DEAD-LETTER state)
 *
 * The C1 delivery-state enum is `pending|delivered|failed`, so `failed` doubles as
 * the dead-letter terminal (documented — no `dead` state exists to add without a
 * contract change). `pending` distinguishes "not yet delivered / awaiting retry"
 * via `attempts` + `next_retry_at`.
 *
 * The subscription secret is used ONLY to compute the signature and is NEVER
 * logged (see {@link safeDeliveryLog}) or returned.
 *
 * Import-safe for direct `node` execution (no enums / namespaces / parameter
 * properties — the host type-stripping constraint).
 */

export interface WebhookSendInput {
  url: string;
  headers: Record<string, string>;
  body: string;
}
export interface WebhookSendResult {
  status: number;
}
/** The single network seam — injected so tests never touch the network. */
export type WebhookSender = (input: WebhookSendInput) => Promise<WebhookSendResult>;

export interface DeliveryDeps {
  db: Db;
  sender: WebhookSender;
  queue: QueueDriver;
  now?: () => Date;
  backoff?: BackoffConfig;
  /** Jitter source for retry scheduling; default `Math.random`. */
  rng?: () => number;
}

export type DeliveryOutcome = 'delivered' | 'retry_scheduled' | 'dead_lettered' | 'skipped';

export interface DeliveryResult {
  kind: DeliveryOutcome;
  deliveryId: string;
  attempts: number;
  status?: number;
  nextRetryAt?: string;
}

interface DeliveryRow {
  state: string;
  attempts: number;
  event: Record<string, unknown>;
  url: string;
  secret: string;
  isActive: boolean;
}

function eventTypeOf(event: Record<string, unknown>): string {
  const t = event['type'];
  return typeof t === 'string' ? t : 'unknown';
}

async function markTerminal(
  db: Db,
  deliveryId: string,
  state: 'delivered' | 'failed',
  attempts: number,
): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({ state, attempts, nextRetryAt: null, updatedAt: sql`now()` })
    .where(eq(webhookDeliveries.id, deliveryId));
}

/**
 * Deliver one webhook. Idempotent: a row already in a terminal state (or gone) is
 * a no-op (`skipped`) — safe under duplicate wake-ups.
 */
export async function processDelivery(
  deps: DeliveryDeps,
  deliveryId: string,
): Promise<DeliveryResult> {
  const now = (deps.now ?? (() => new Date()))();
  const backoff = deps.backoff ?? DEFAULT_BACKOFF;
  const rng = deps.rng ?? Math.random;

  const rows = await deps.db
    .select({
      state: webhookDeliveries.state,
      attempts: webhookDeliveries.attempts,
      event: webhookDeliveries.event,
      url: webhookSubscriptions.url,
      secret: webhookSubscriptions.secret,
      isActive: webhookSubscriptions.isActive,
    })
    .from(webhookDeliveries)
    .innerJoin(webhookSubscriptions, eq(webhookDeliveries.subscriptionId, webhookSubscriptions.id))
    .where(eq(webhookDeliveries.id, deliveryId))
    .limit(1);
  const d: DeliveryRow | undefined = rows[0];
  if (d === undefined) return { kind: 'skipped', deliveryId, attempts: 0 };
  if (d.state !== 'pending') return { kind: 'skipped', deliveryId, attempts: d.attempts };

  // A subscription deactivated after the row was queued: do not deliver — retire it.
  if (!d.isActive) {
    await markTerminal(deps.db, deliveryId, 'failed', d.attempts);
    return { kind: 'dead_lettered', deliveryId, attempts: d.attempts };
  }

  const body = JSON.stringify(d.event);
  const tsSec = Math.floor(now.getTime() / 1000);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    [SIGNATURE_HEADER]: buildSignatureHeader(d.secret, tsSec, body),
    'x-switchboard-event': eventTypeOf(d.event),
    'x-switchboard-delivery': deliveryId,
  };

  const attemptsAfter = d.attempts + 1;
  let status: number | undefined;
  let ok = false;
  try {
    const res = await deps.sender({ url: d.url, headers, body });
    status = res.status;
    ok = status >= 200 && status < 300;
  } catch {
    ok = false;
  }

  if (ok) {
    await markTerminal(deps.db, deliveryId, 'delivered', attemptsAfter);
    return {
      kind: 'delivered',
      deliveryId,
      attempts: attemptsAfter,
      ...(status !== undefined ? { status } : {}),
    };
  }

  if (isDeadLettered(attemptsAfter, backoff)) {
    await markTerminal(deps.db, deliveryId, 'failed', attemptsAfter);
    return {
      kind: 'dead_lettered',
      deliveryId,
      attempts: attemptsAfter,
      ...(status !== undefined ? { status } : {}),
    };
  }

  const delayMs = nextRetryDelayMs(attemptsAfter, backoff, rng);
  const nextRetryAt = new Date(now.getTime() + delayMs).toISOString();
  await deps.db
    .update(webhookDeliveries)
    .set({ state: 'pending', attempts: attemptsAfter, nextRetryAt, updatedAt: sql`now()` })
    .where(eq(webhookDeliveries.id, deliveryId));
  await deps.queue.enqueue(
    WEBHOOK_DELIVERY_JOB,
    { deliveryId },
    { delayMs, jobId: webhookDeliveryJobId(deliveryId) },
  );
  return {
    kind: 'retry_scheduled',
    deliveryId,
    attempts: attemptsAfter,
    nextRetryAt,
    ...(status !== undefined ? { status } : {}),
  };
}

/** Extract `deliveryId` from a delivery job's payload. */
function deliveryIdFromJob(job: QueueJob): string | null {
  const id = job.data['deliveryId'];
  return typeof id === 'string' ? id : null;
}

/**
 * A {@link JobProcessor} for `webhook:deliver` jobs. In production the composition
 * root registers ONE queue processor that switches on `job.name` and delegates
 * here for webhook jobs (the sequence engine owns `sequence:send`); tests register
 * this directly on a dedicated driver. Non-webhook jobs are ignored.
 */
export function createWebhookDeliveryProcessor(deps: DeliveryDeps): JobProcessor {
  return async (job: QueueJob): Promise<void> => {
    if (job.name !== WEBHOOK_DELIVERY_JOB) return;
    const deliveryId = deliveryIdFromJob(job);
    if (deliveryId === null) return;
    await processDelivery(deps, deliveryId);
  };
}

export interface DeliveryLogInput {
  deliveryId: string;
  subscriptionId: string;
  url: string;
  eventType: string;
  attempt: number;
  state: string;
  status?: number;
  /** Present in the type ONLY to prove it is structurally dropped — never emitted. */
  secret?: string;
}

/**
 * Build a SAFE structured-log record for a delivery attempt. The signing secret is
 * never included — structurally (it is not read) and defensively (the result is
 * passed through the audit redactor, which blanks any credential-looking key). This
 * is the "delivery logs redact too" guarantee (D-021, task ask).
 */
export function safeDeliveryLog(input: DeliveryLogInput): Record<string, unknown> {
  const record: Record<string, unknown> = {
    deliveryId: input.deliveryId,
    subscriptionId: input.subscriptionId,
    url: input.url,
    eventType: input.eventType,
    attempt: input.attempt,
    state: input.state,
    ...(input.status !== undefined ? { status: input.status } : {}),
  };
  return redactSnapshot(record);
}
