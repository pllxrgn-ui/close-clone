/**
 * Inbox action errors, mapped to CONTRACTS §C8 codes by the route
 * (`routes/inbox.ts`). Mirrors the web mock's typed errors so the same UI toasts
 * fire: a DNC-blocked approval surfaces as SUPPRESSED (422), a missing item as
 * NOT_FOUND (404); a step that is no longer awaiting review is a CONFLICT (409).
 */

export class InboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InboxError';
  }
}

/** The referenced item does not exist → NOT_FOUND (404). */
export class InboxNotFoundError extends InboxError {
  constructor(message = 'Inbox item not found') {
    super(message);
    this.name = 'InboxNotFoundError';
  }
}

/** Outreach attempted against a DNC lead/contact → SUPPRESSED (422). */
export class InboxSuppressedError extends InboxError {
  constructor(message = 'Recipient is on the do-not-contact list') {
    super(message);
    this.name = 'InboxSuppressedError';
  }
}

/** The step is no longer awaiting review (already dispositioned) → CONFLICT (409). */
export class InboxConflictError extends InboxError {
  constructor(message = 'Review step is no longer awaiting review') {
    super(message);
    this.name = 'InboxConflictError';
  }
}
