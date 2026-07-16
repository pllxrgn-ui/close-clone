/**
 * Typed errors for the outbound-webhook module (Task 5c). CRUD-layer errors the
 * admin route maps mechanically to the C8 envelope.
 *
 * Import-safe for direct `node` execution (no enums / namespaces / parameter
 * properties — the host type-stripping constraint).
 */

export class WebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookError';
  }
}

/** Bad create/update input a route's zod did not catch (business rule) → 400. */
export class WebhookValidationError extends WebhookError {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookValidationError';
  }
}

/** Subscription id not found → 404. */
export class WebhookSubscriptionNotFoundError extends WebhookError {
  readonly subscriptionId: string;
  constructor(subscriptionId: string) {
    super(`webhook subscription ${subscriptionId} not found`);
    this.name = 'WebhookSubscriptionNotFoundError';
    this.subscriptionId = subscriptionId;
  }
}

/**
 * Hard-delete refused because delivery history references the subscription
 * (`webhook_deliveries.subscription_id` is `on delete restrict`, C1) → 409. The
 * caller should deactivate instead (PATCH `isActive:false`) to preserve the ledger.
 */
export class WebhookHasDeliveriesError extends WebhookError {
  readonly subscriptionId: string;
  constructor(subscriptionId: string) {
    super(
      `webhook subscription ${subscriptionId} has delivery history and cannot be deleted; ` +
        `deactivate it instead`,
    );
    this.name = 'WebhookHasDeliveriesError';
    this.subscriptionId = subscriptionId;
  }
}
