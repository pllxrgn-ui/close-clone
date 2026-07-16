import type { JsonWebKey, KeyObject } from 'node:crypto';

import { z } from 'zod';

import { importRsaJwk } from './jwt.ts';
import type { HttpTransport } from './transport.ts';

/**
 * JWKS fetch + cache with kid-rotation handling (Task 5a). ID tokens name the
 * signing key by `kid` in their header; this cache maps `kid → public key` and
 * refetches on a cache miss so a *rotated-in* key is picked up automatically. A
 * `kid` that is still missing after a fresh fetch (a *rotated-out* / expired key)
 * fails closed with {@link JwksKeyNotFoundError} — the token cannot be verified,
 * so it is rejected. Refetches are rate-limited so an unknown-`kid` token can't be
 * used to hammer the IdP (a cheap DoS otherwise).
 */

export const jwkSchema = z
  .object({
    kty: z.string(),
    kid: z.string().optional(),
    alg: z.string().optional(),
    use: z.string().optional(),
    n: z.string().optional(),
    e: z.string().optional(),
  })
  .passthrough();

export const jwksSchema = z.object({ keys: z.array(jwkSchema) });
export type Jwks = z.infer<typeof jwksSchema>;

export class JwksError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwksError';
  }
}

/** The signing key named by a token's `kid` is not in the JWKS (rotated out). */
export class JwksKeyNotFoundError extends JwksError {
  readonly kid: string;
  constructor(kid: string) {
    super(`no JWKS key for kid '${kid}'`);
    this.name = 'JwksKeyNotFoundError';
    this.kid = kid;
  }
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h proactive refresh
const DEFAULT_MIN_REFETCH_MS = 60 * 1000; // ≥60s between forced refetches

export interface JwksCacheOptions {
  transport: HttpTransport;
  now?: () => Date;
  /** Proactive re-fetch age. */
  ttlMs?: number;
  /** Floor between miss-driven refetches (anti-DoS). */
  minRefetchMs?: number;
}

interface CacheState {
  keys: Map<string, JsonWebKey>;
  fetchedAtMs: number;
}

export class JwksCache {
  private readonly jwksUri: string;
  private readonly transport: HttpTransport;
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly minRefetchMs: number;
  private state: CacheState | null = null;
  private lastFetchAttemptMs = 0;
  private inFlight: Promise<CacheState> | null = null;

  constructor(jwksUri: string, opts: JwksCacheOptions) {
    this.jwksUri = jwksUri;
    this.transport = opts.transport;
    this.now = opts.now ?? (() => new Date());
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.minRefetchMs = opts.minRefetchMs ?? DEFAULT_MIN_REFETCH_MS;
  }

  /** Resolve the public key for `kid`, refetching once on a miss (rotation). */
  async getKey(kid: string): Promise<KeyObject> {
    let state = this.state;
    if (state === null || !this.fresh(state) || !state.keys.has(kid)) {
      state = await this.refresh(state);
    }
    const jwk = state.keys.get(kid);
    if (jwk === undefined) throw new JwksKeyNotFoundError(kid);
    return importRsaJwk(jwk);
  }

  private fresh(state: CacheState): boolean {
    return this.now().getTime() - state.fetchedAtMs < this.ttlMs;
  }

  private async refresh(current: CacheState | null): Promise<CacheState> {
    const nowMs = this.now().getTime();
    // Anti-DoS: if we fetched very recently and still have a cache, reuse it —
    // an attacker replaying an unknown kid cannot force unbounded upstream calls.
    if (
      current !== null &&
      this.fresh(current) &&
      nowMs - this.lastFetchAttemptMs < this.minRefetchMs
    ) {
      return current;
    }
    this.inFlight ??= this.fetch();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async fetch(): Promise<CacheState> {
    this.lastFetchAttemptMs = this.now().getTime();
    const raw = await this.transport.getJson(this.jwksUri);
    const parsed = jwksSchema.safeParse(raw);
    if (!parsed.success) throw new JwksError(`invalid JWKS: ${parsed.error.message}`);
    const keys = new Map<string, JsonWebKey>();
    for (const jwk of parsed.data.keys) {
      if (jwk.kid !== undefined) keys.set(jwk.kid, jwk as JsonWebKey);
    }
    const state: CacheState = { keys, fetchedAtMs: this.now().getTime() };
    this.state = state;
    return state;
  }
}
