/**
 * Queue job identifiers for outbound webhook delivery (Task 5c). The processor
 * switches on {@link WEBHOOK_DELIVERY_JOB}; `jobId` is the per-delivery dedupe key
 * so a duplicated wake-up (fan-out + a would-be sweeper) collapses to one job
 * (ARCHITECTURE §4 — the queue is only a hint; the ledger is authoritative).
 *
 * Import-safe for direct `node` execution (no enums / namespaces / parameter
 * properties — the host type-stripping constraint).
 */

export const WEBHOOK_DELIVERY_JOB = 'webhook:deliver';

export function webhookDeliveryJobId(deliveryId: string): string {
  return `webhook-delivery:${deliveryId}`;
}
