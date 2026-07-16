import { z } from 'zod';

/**
 * Outbound webhook event taxonomy (Task 5c). The event kinds Switchboard fans out
 * to subscribers: lead, opportunity, and activity changes (the task's named set).
 * A subscription's `events` jsonb lists the types it wants; `'*'` means all.
 *
 * These are the WIRE contract for subscribers, deliberately coarse and stable —
 * distinct from the fine-grained internal C4 activity taxonomy. The activity
 * spine collapses into a single `activity.recorded` event carrying the C4 `type`
 * in its data, so adding a C4 activity type never silently changes the webhook
 * surface.
 *
 * Import-safe for direct `node` execution (no enums / namespaces / parameter
 * properties — the host type-stripping constraint).
 */

export const WEBHOOK_EVENT_TYPES = [
  'lead.created',
  'lead.updated',
  'lead.merged',
  'opportunity.created',
  'opportunity.stage_changed',
  'opportunity.closed',
  'activity.recorded',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const webhookEventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES);

/** Wildcard a subscription may list to receive every event type. */
export const WILDCARD_EVENT = '*';

const EVENT_SET: ReadonlySet<string> = new Set(WEBHOOK_EVENT_TYPES);

export function isWebhookEventType(value: unknown): value is WebhookEventType {
  return typeof value === 'string' && EVENT_SET.has(value);
}

/**
 * The envelope POSTed to a subscriber (also the JSON body the signature covers).
 * `id` is stable per logical event so a subscriber can dedupe replays.
 */
export interface WebhookEvent {
  id: string;
  type: WebhookEventType;
  /** ISO-8601 event time. */
  occurredAt: string;
  data: Record<string, unknown>;
}

/**
 * Validate/normalise a subscription's `events` jsonb selector into a list of known
 * event types plus an all-flag. Unknown entries are dropped; `'*'` sets `all`.
 */
export function parseSubscribedEvents(raw: unknown): { all: boolean; types: WebhookEventType[] } {
  if (!Array.isArray(raw)) return { all: false, types: [] };
  let all = false;
  const types: WebhookEventType[] = [];
  for (const entry of raw) {
    if (entry === WILDCARD_EVENT) all = true;
    else if (isWebhookEventType(entry) && !types.includes(entry)) types.push(entry);
  }
  return { all, types };
}

/** True iff a subscription selecting `subscribed` should receive `type`. */
export function subscriptionMatches(subscribed: unknown, type: WebhookEventType): boolean {
  const { all, types } = parseSubscribedEvents(subscribed);
  return all || types.includes(type);
}

/** Validate a selector array for the CRUD surface (every entry known, or `'*'`). */
export function assertValidEventSelectors(raw: unknown[]): void {
  for (const entry of raw) {
    if (entry !== WILDCARD_EVENT && !isWebhookEventType(entry)) {
      throw new Error(`unknown webhook event type: ${JSON.stringify(entry)}`);
    }
  }
}
