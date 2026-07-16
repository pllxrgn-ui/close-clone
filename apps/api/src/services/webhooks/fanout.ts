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
 * Fan a domain event out to matching active subscriptions. Returns the created
 * delivery ids (empty when nothing matched — a no-op, not an error).
 */
export async function emitWebhookEvent(
  deps: FanoutDeps,
  input: EmitEventInput,
): Promise<EmitResult> {
  const now = (deps.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const eventId = input.id ?? randomUUID();

  // The stored/POSTed envelope (typed as a JSON record for the jsonb column).
  const envelope: Record<string, unknown> = {
    id: eventId,
    type: input.type,
    occurredAt: input.occurredAt ?? nowIso,
    data: input.data,
  };

  const subs = await deps.db
    .select({ id: webhookSubscriptions.id, events: webhookSubscriptions.events })
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.isActive, true));

  const matching = subs.filter((s) => subscriptionMatches(s.events, input.type));
  if (matching.length === 0) return { eventId, deliveryIds: [] };

  const deliveryIds: string[] = [];
  for (const sub of matching) {
    const inserted = await deps.db
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

  // Enqueue wake-ups only after the rows exist (durable-first).
  for (const id of deliveryIds) {
    await deps.queue.enqueue(
      WEBHOOK_DELIVERY_JOB,
      { deliveryId: id },
      { jobId: webhookDeliveryJobId(id) },
    );
  }

  return { eventId, deliveryIds };
}
