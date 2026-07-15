import { syncStatusValues } from '@switchboard/shared';

/**
 * Typed errors for the mailbox sync engine (CONTRACTS §C5). HTTP mapping is
 * mechanical at the route layer (§C8): `AccountNotFoundError` → NOT_FOUND,
 * `IllegalTransitionError` → CONFLICT, `ReauthRequiredError` → SYNC_REAUTH_REQUIRED.
 */

/** The C5 sync states (derived from the shared enum values — no separate type). */
export type SyncStatus = (typeof syncStatusValues)[number];

export class SyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncError';
  }
}

/** The target `email_accounts` row does not exist. */
export class AccountNotFoundError extends SyncError {
  readonly accountId: string;
  constructor(accountId: string) {
    super(`email account ${accountId} not found`);
    this.name = 'AccountNotFoundError';
    this.accountId = accountId;
  }
}

/** A `SyncStateService.transition` call that the C5 state machine forbids. */
export class IllegalTransitionError extends SyncError {
  readonly from: SyncStatus;
  readonly to: SyncStatus;
  constructor(from: SyncStatus, to: SyncStatus) {
    super(`illegal sync transition ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
  }
}

/** A worker ran against an account whose refresh token is dead (REAUTH_REQUIRED). */
export class ReauthRequiredError extends SyncError {
  readonly accountId: string;
  constructor(accountId: string) {
    super(`email account ${accountId} requires re-authentication`);
    this.name = 'ReauthRequiredError';
    this.accountId = accountId;
  }
}
