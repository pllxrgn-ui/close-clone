/**
 * Outbound webhooks module barrel (Task 5c). Subscription CRUD (secret shown once,
 * never on read/export), HMAC-SHA256 signing with a documented replay window,
 * fan-out of lead/opportunity/activity events, and a delivery worker with
 * exponential backoff + jitter and dead-lettering — all runnable under MOCK_MODE
 * with an in-process queue and a fake HTTP sender (no network).
 */

export {
  WEBHOOK_EVENT_TYPES,
  WILDCARD_EVENT,
  assertValidEventSelectors,
  isWebhookEventType,
  parseSubscribedEvents,
  subscriptionMatches,
  webhookEventTypeSchema,
  type WebhookEvent,
  type WebhookEventType,
} from './events.ts';

export {
  SIGNATURE_HEADER,
  DEFAULT_REPLAY_TOLERANCE_SEC,
  buildSignatureHeader,
  computeSignature,
  parseSignatureHeader,
  verifySignature,
  type ParsedSignature,
  type VerifyOptions,
} from './signing.ts';

export {
  DEFAULT_BACKOFF,
  backoffCeilingMs,
  isDeadLettered,
  nextRetryDelayMs,
  type BackoffConfig,
} from './backoff.ts';

export {
  WebhookError,
  WebhookValidationError,
  WebhookSubscriptionNotFoundError,
  WebhookHasDeliveriesError,
} from './errors.ts';

export {
  WebhookSubscriptionService,
  generateWebhookSecret,
  type WebhookSubscriptionView,
  type CreatedSubscription,
  type CreateSubscriptionInput,
  type UpdateSubscriptionInput,
  type ListSubscriptionsFilter,
  type ListSubscriptionsPage,
} from './service.ts';

export {
  emitWebhookEvent,
  writeWebhookDeliveries,
  enqueueWebhookDeliveries,
  createActivityWebhookEmitter,
  type EmitEventInput,
  type EmitResult,
  type FanoutDeps,
} from './fanout.ts';

export {
  processDelivery,
  createWebhookDeliveryProcessor,
  safeDeliveryLog,
  type DeliveryDeps,
  type DeliveryResult,
  type DeliveryOutcome,
  type DeliveryLogInput,
  type WebhookSender,
  type WebhookSendInput,
  type WebhookSendResult,
} from './delivery.ts';

export { WEBHOOK_DELIVERY_JOB, webhookDeliveryJobId } from './job-names.ts';
