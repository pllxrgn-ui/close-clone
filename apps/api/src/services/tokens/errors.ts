/**
 * Typed errors for the token service (Task 5c). CRUD-layer errors the admin route
 * maps mechanically to the C8 envelope. The bearer preHandler does NOT throw these
 * — it writes the C8 error directly (auth failures are a response, not an
 * exception) — so these cover only the management surface (create/revoke/list).
 *
 * Import-safe for direct `node` execution (no enums / namespaces / parameter
 * properties — the host type-stripping constraint).
 */

export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenError';
  }
}

/** Bad create/revoke input a route's zod did not catch (business rule) → 400. */
export class TokenValidationError extends TokenError {
  constructor(message: string) {
    super(message);
    this.name = 'TokenValidationError';
  }
}

/** Token id not found (revoke/get of a missing token) → 404. */
export class TokenNotFoundError extends TokenError {
  readonly tokenId: string;
  constructor(tokenId: string) {
    super(`api token ${tokenId} not found`);
    this.name = 'TokenNotFoundError';
    this.tokenId = tokenId;
  }
}

/**
 * The reason a bearer credential was refused — carried on the audit row and,
 * except for `rate_limited`, mapped to `UNAUTHENTICATED`/`FORBIDDEN`.
 */
export type DenialReason =
  | 'missing_token'
  | 'malformed_token'
  | 'unknown_token'
  | 'revoked_or_expired'
  | 'insufficient_scope'
  | 'rate_limited';
