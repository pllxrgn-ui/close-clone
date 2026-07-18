import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { webhookDeliveries, webhookSubscriptions, type Db } from '../../db/index.ts';
import type { QueueDriver } from '../../queue/index.ts';
import { subscriptionMatches, type WebhookEventType } from './events.ts';
import { WEBHOOK_DELIVERY_JOB, webhookDeliveryJobId } from './job-names.ts';

/**
 * Outbound event fan-out (Task 5c, ARCHITECTURE §5 "Webhook fan-out"). Given a
 * domain event (lead/opportunity/activity), it writes ONE `webhook_deliveries` row
 * per active subscription whose selector matches, then enqueues a delivery wake-up
 * per row. The delivery envelope is stored self-contained on the row, so a later
 * record change never alters what a subscriber receives.
 *
 * Postgres is authoritative: rows are inserted first (inside the caller's flow),
 * wake-ups enqueued after — a lost wake-up is harmless because the row is durable
 * and a sweeper (or manual replay) can re-drive it. Call this AFTER the source
 * mutation's transaction commits (the write-path wiring is the composition root's
 * job; see the task report's routeWiring).
 *
 * Import-safe for direct `node` execution (no enums / namespaces / parameter
 * properties — the host type-stripping constraint).
 */

export interface FanoutDeps {
  db: Db;
  queue: QueueDriver;
  now?: () => Date;
}

export interface EmitEventInput {
  type: WebhookEventType;
  data: Record<string, unknown>;
  /** Logical event id (subscriber dedupe key); default a fresh uuid. */
  id?: string;
  /** Event time (ISO); default now. */
  occurredAt?: string;
}

export interface EmitResult {
  eventId: string;
  deliveryIds: string[];
}

/**
 * Write the durable `webhook_deliveries` rows for a domain event — the DB half
 * of fan-out, with NO enqueue. `db` may be a transaction handle, so a caller can
 * stage deliveries atomically with the source mutation (the activity spine does
 * exactly this — see recordActivity). Returns the delivery ids to enqueue after
 * the enclosing transaction commits.
 */
export async function writeWebhookDeliveries(db: Db, input: EmitEventInput): Promise<EmitResult> {
  const nowIso = input.occurredAt ?? new Date().toISOString();
  const eventId = input.id ?? randomUUID();

  const envelope: Record<string, unknown> = {
    id: eventId,
    type: input.type,
    occurredAt: input.occurredAt ?? nowIso,
    data: input.data,
  };

  const subs = await db
    .select({ id: webhookSubscriptions.id, events: webhookSubscriptions.events })
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.isActive, true));

  const matching = subs.filter((s) => subscriptionMatches(s.events, input.type));
  if (matching.length === 0) return { eventId, deliveryIds: [] };

  const deliveryIds: string[] = [];
  for (const sub of matching) {
    const inserted = await db
      .insert(webhookDeliveries)
      .values({
        subscriptionId: sub.id,
        event: envelope,
        state: 'pending',
        attempts: 0,
        // Due immediately; the delivery worker owns retry scheduling from here.
        nextRetryAt: nowIso,
      })
      .returning({ id: webhookDeliveries.id });
    const id = inserted[0]?.id;
    if (id !== undefined) deliveryIds.push(id);
  }
  return { eventId, deliveryIds };
}

/** Enqueue the delivery wake-ups — the queue half, run AFTER the rows commit. */
export async function enqueueWebhookDeliveries(
  queue: QueueDriver,
  deliveryIds: string[],
): Promise<void> {
  for (const id of deliveryIds) {
    await queue.enqueue(
      WEBHOOK_DELIVERY_JOB,
      { deliveryId: id },
      { jobId: webhookDeliveryJobId(id) },
    );
  }
}

/**
 * Fan a domain event out to matching active subscriptions (write rows, then
 * enqueue). Returns the created delivery ids (empty when nothing matched — a
 * no-op, not an error). Use this for post-commit emission where the caller has a
 * plain db handle; for in-transaction staging use writeWebhookDeliveries +
 * enqueueWebhookDeliveries directly (see {@link createActivityWebhookEmitter}).
 */
export async function emitWebhookEvent(
  deps: FanoutDeps,
  input: EmitEventInput,
): Promise<EmitResult> {
  const withNow: EmitEventInput =
    input.occurredAt === undefined
      ? { ...input, occurredAt: (deps.now ?? (() => new Date()))().toISOString() }
      : input;
  const result = await writeWebhookDeliveries(deps.db, withNow);
  await enqueueWebhookDeliveries(deps.queue, result.deliveryIds);
  return result;
}

/**
 * The activity spine's webhook emitter (see recordActivity's
 * ActivityWebhookEmitter): `stage` writes delivery rows inside the record
 * transaction; `flush` enqueues the wake-ups after it commits. Structurally
 * typed — no import from the activity service, so no cross-service coupling.
 */
export function createActivityWebhookEmitter(queue: QueueDriver): {
  stage(tx: Db, event: { type: string; data: Record<string, unknown> }): Promise<string[]>;
  flush(deliveryIds: string[]): Promise<void>;
} {
  return {
    stage: async (tx, event) => {
      const result = await writeWebhookDeliveries(tx, {
        type: event.type as WebhookEventType,
        data: event.data,
      });
      return result.deliveryIds;
    },
    flush: (deliveryIds) => enqueueWebhookDeliveries(queue, deliveryIds),
  };
}
