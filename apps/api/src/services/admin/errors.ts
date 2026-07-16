/**
 * Admin-CRUD service error taxonomy. The services in this directory are HTTP-
 * agnostic; they throw these typed errors and the route layer (`routes/admin-crud.ts`)
 * maps each to its CONTRACTS §C8 code + status via `mapAdminError`. Keeping the
 * mapping in one place means every admin resource reports failures identically.
 *
 * `details` rides along on a validation/conflict error so the C8 envelope can
 * carry the offending `{ field }` — the exact shape the web's create-field form
 * (and the MSW it replaces) already renders.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export class AdminError extends Error {
  readonly details: unknown;
  constructor(message: string, details?: unknown) {
    super(message);
    this.name = 'AdminError';
    this.details = details;
  }
}

/** Bad input → VALIDATION_FAILED (400). */
export class AdminValidationError extends AdminError {
  constructor(message: string, details?: unknown) {
    super(message, details);
    this.name = 'AdminValidationError';
  }
}

/** Uniqueness/duplicate violation → CONFLICT (409). */
export class AdminConflictError extends AdminError {
  constructor(message: string, details?: unknown) {
    super(message, details);
    this.name = 'AdminConflictError';
  }
}

/** Target row not found → NOT_FOUND (404). */
export class AdminNotFoundError extends AdminError {
  constructor(message: string, details?: unknown) {
    super(message, details);
    this.name = 'AdminNotFoundError';
  }
}

/** Refused by a compliance rail → FORBIDDEN (403). */
export class AdminForbiddenError extends AdminError {
  constructor(message: string, details?: unknown) {
    super(message, details);
    this.name = 'AdminForbiddenError';
  }
}
