import { and, desc, eq, isNull, lt, or, sql, type SQL } from 'drizzle-orm';

import { apiTokens, type Db } from '../../db/index.ts';
import { generateTokenPlaintext, hashToken } from './hash.ts';
import { TokenNotFoundError, TokenValidationError, type DenialReason } from './errors.ts';
import { parseScopes, type ApiScope } from './scopes.ts';

/**
 * Token management + authentication (Task 5c, CONTRACTS §C1 `api_tokens`).
 *
 * Create returns the plaintext EXACTLY ONCE; only its sha256 hash is stored, so no
 * read path can ever reconstruct a usable credential (`hash` is never selected into
 * a view — CONTRACTS §1 "no password store EVER" / D-021 credential-material rule).
 *
 * VALIDITY MODEL — `revoked_at` is overloaded as "the instant at/after which this
 * token is invalid": explicit `revoke()` sets it to now; an optional creation-time
 * `expiresAt` sets it to a future instant (scheduled expiry). One gate,
 * {@link tokenValid}, covers both the "revoked" and "expired" refusals the task
 * requires. CONTRACT FRICTION (reported): C1 lacks a dedicated `expires_at`, so
 * "revoked" and "expired" are indistinguishable in listings; a follow-up column
 * would separate them.
 *
 * Import-safe for direct `node` execution (no enums / namespaces / parameter
 * properties — the host type-stripping constraint).
 */

export interface CreateTokenInput {
  name: string;
  scopes: ApiScope[];
  /** The admin user minting the token (audit + `created_by`). */
  createdBy?: string;
  /** Optional scheduled expiry (ISO or Date). Stored in `revoked_at` — see note. */
  expiresAt?: string | Date;
}

/** The safe, hash-free projection of an `api_tokens` row (never leaves the server with `hash`). */
export interface ApiTokenView {
  id: string;
  name: string;
  scopes: ApiScope[];
  createdBy: string | null;
  lastUsedAt: string | null;
  /** Not-valid-after instant (explicit revoke OR scheduled expiry), or null. */
  revokedAt: string | null;
  /** Computed against the service clock: `active` while valid, else `revoked`. */
  status: 'active' | 'revoked';
  createdAt: string;
  updatedAt: string;
}

export interface CreatedToken {
  token: ApiTokenView;
  /** Shown to the creator ONCE; never stored, never returned again. */
  plaintext: string;
}

export interface AuthenticatedToken {
  id: string;
  scopes: ApiScope[];
  createdBy: string | null;
}

export type AuthOutcome =
  | { ok: true; token: AuthenticatedToken }
  | { ok: false; reason: DenialReason; tokenId?: string; createdBy?: string | null };

export interface ListTokensFilter {
  createdBy?: string;
  limit?: number;
  cursor?: string;
}

export interface ListTokensPage {
  items: ApiTokenView[];
  nextCursor?: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Columns of the safe view — `hash` is deliberately excluded. */
const VIEW_COLUMNS = {
  id: apiTokens.id,
  name: apiTokens.name,
  scopes: apiTokens.scopes,
  createdBy: apiTokens.createdBy,
  lastUsedAt: apiTokens.lastUsedAt,
  revokedAt: apiTokens.revokedAt,
  createdAt: apiTokens.createdAt,
  updatedAt: apiTokens.updatedAt,
} as const;

interface ViewRow {
  id: string;
  name: string;
  scopes: unknown;
  createdBy: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** True iff a token is invalid at `nowMs` (revoked or past its scheduled expiry). */
function isInvalidAt(revokedAt: string | null, nowMs: number): boolean {
  return revokedAt !== null && new Date(revokedAt).getTime() <= nowMs;
}

function toView(row: ViewRow, nowMs: number): ApiTokenView {
  return {
    id: row.id,
    name: row.name,
    scopes: parseScopes(row.scopes),
    createdBy: row.createdBy,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    status: isInvalidAt(row.revokedAt, nowMs) ? 'revoked' : 'active',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

interface Cursor {
  createdAt: string;
  id: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): Cursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { createdAt, id } = parsed as Record<string, unknown>;
    if (typeof createdAt !== 'string' || typeof id !== 'string') return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function toIso(value: string | Date): string {
  return typeof value === 'string' ? value : value.toISOString();
}

export class TokenService {
  private readonly db: Db;
  private readonly now: () => Date;

  constructor(db: Db, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  /**
   * Mint a token. Returns the plaintext ONCE alongside the stored (hash-free) view.
   * Requires at least one scope — a scopeless token can do nothing and is a mistake.
   */
  async create(input: CreateTokenInput): Promise<CreatedToken> {
    const name = input.name.trim();
    if (name.length === 0) throw new TokenValidationError('token name is required');
    if (input.scopes.length === 0) {
      throw new TokenValidationError('a token must be granted at least one scope');
    }
    const nowMs = this.now().getTime();
    const revokedAt = input.expiresAt !== undefined ? toIso(input.expiresAt) : null;
    if (revokedAt !== null && new Date(revokedAt).getTime() <= nowMs) {
      throw new TokenValidationError('expiresAt must be in the future');
    }

    const plaintext = generateTokenPlaintext();
    const hash = hashToken(plaintext);

    const inserted = await this.db
      .insert(apiTokens)
      .values({
        name,
        hash,
        scopes: input.scopes,
        ...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {}),
        ...(revokedAt !== null ? { revokedAt } : {}),
      })
      .returning(VIEW_COLUMNS);
    const row = inserted[0];
    if (row === undefined) throw new TokenValidationError('token insert returned no row');
    return { token: toView(row, nowMs), plaintext };
  }

  /**
   * Revoke a token NOW (idempotent). Revoking a token that is scheduled to expire
   * later moves its invalidation forward to now; an already-invalid token is left
   * as-is. Unknown id → {@link TokenNotFoundError}.
   */
  async revoke(tokenId: string): Promise<ApiTokenView> {
    const nowMs = this.now().getTime();
    const nowIso = new Date(nowMs).toISOString();

    const current = await this.db
      .select(VIEW_COLUMNS)
      .from(apiTokens)
      .where(eq(apiTokens.id, tokenId))
      .limit(1);
    const existing = current[0];
    if (existing === undefined) throw new TokenNotFoundError(tokenId);
    if (isInvalidAt(existing.revokedAt, nowMs)) return toView(existing, nowMs);

    const updated = await this.db
      .update(apiTokens)
      .set({ revokedAt: nowIso, updatedAt: sql`now()` })
      .where(eq(apiTokens.id, tokenId))
      .returning(VIEW_COLUMNS);
    const row = updated[0];
    if (row === undefined) throw new TokenNotFoundError(tokenId);
    return toView(row, nowMs);
  }

  /** List tokens newest-first, keyset-paginated. Never includes `hash`. */
  async list(filter: ListTokensFilter = {}): Promise<ListTokensPage> {
    const nowMs = this.now().getTime();
    const limit = clampLimit(filter.limit);
    const cursor = filter.cursor !== undefined ? decodeCursor(filter.cursor) : null;
    if (filter.cursor !== undefined && cursor === null) {
      throw new TokenValidationError('invalid cursor');
    }

    const conds: SQL[] = [];
    if (filter.createdBy !== undefined) conds.push(eq(apiTokens.createdBy, filter.createdBy));
    if (cursor) {
      const keyset = or(
        lt(apiTokens.createdAt, cursor.createdAt),
        and(eq(apiTokens.createdAt, cursor.createdAt), lt(apiTokens.id, cursor.id)),
      );
      if (keyset) conds.push(keyset);
    }
    const where = conds.length > 0 ? and(...conds) : undefined;

    const rows = await this.db
      .select(VIEW_COLUMNS)
      .from(apiTokens)
      .where(where)
      .orderBy(desc(apiTokens.createdAt), desc(apiTokens.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map((r) => toView(r, nowMs));
    if (!hasMore) return { items };
    const last = pageRows[pageRows.length - 1];
    if (last === undefined) return { items };
    return { items, nextCursor: encodeCursor({ createdAt: last.createdAt, id: last.id }) };
  }

  /**
   * Resolve a presented token plaintext to an authenticated identity, or a typed
   * denial reason. Lookup is by indexed sha256 hash; validity is the `revoked_at`
   * gate. Does NOT check scope or rate limit — those are the preHandler's job.
   */
  async authenticate(plaintext: string): Promise<AuthOutcome> {
    const nowMs = this.now().getTime();
    const hash = hashToken(plaintext);
    const rows = await this.db
      .select({
        id: apiTokens.id,
        scopes: apiTokens.scopes,
        createdBy: apiTokens.createdBy,
        revokedAt: apiTokens.revokedAt,
      })
      .from(apiTokens)
      .where(eq(apiTokens.hash, hash))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return { ok: false, reason: 'unknown_token' };
    if (isInvalidAt(row.revokedAt, nowMs)) {
      return { ok: false, reason: 'revoked_or_expired', tokenId: row.id, createdBy: row.createdBy };
    }
    return {
      ok: true,
      token: { id: row.id, scopes: parseScopes(row.scopes), createdBy: row.createdBy },
    };
  }

  /**
   * Throttled `last_used_at` bump: writes at most once per `throttleMs` per token
   * (a conditional UPDATE, no prior read), so the hot auth path is not a write per
   * request. Returns true iff a row was updated.
   */
  async touchLastUsed(tokenId: string, throttleMs = 60_000): Promise<boolean> {
    const nowMs = this.now().getTime();
    const nowIso = new Date(nowMs).toISOString();
    const thresholdIso = new Date(nowMs - throttleMs).toISOString();
    const updated = await this.db
      .update(apiTokens)
      .set({ lastUsedAt: nowIso })
      .where(
        and(
          eq(apiTokens.id, tokenId),
          or(isNull(apiTokens.lastUsedAt), lt(apiTokens.lastUsedAt, thresholdIso)),
        ),
      )
      .returning({ id: apiTokens.id });
    return updated.length > 0;
  }
}
