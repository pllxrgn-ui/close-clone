import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

import type { Db } from '../../db/index.ts';
import { requestActor, writeAudit } from '../audit/index.ts';
import { sendError, type ErrorCode } from '../../routes/http.ts';
import { looksLikeToken } from './hash.ts';
import { PostgresRateLimiter } from './rate-limit.ts';
import { hasScope, type ApiScope } from './scopes.ts';
import { TokenService, type AuthenticatedToken } from './service.ts';
import type { DenialReason } from './errors.ts';

/**
 * Bearer-token auth preHandler factory (Task 5c, CONTRACTS §C7 "Authorization:
 * Bearer <token>, scoped" / §C8). Each internal route mounts one, declaring the
 * scope it needs. The pipeline, in order:
 *
 *   1. extract `Authorization: Bearer <token>`  → 401 if absent/malformed;
 *   2. authenticate (indexed sha256 lookup + revoked/expired gate) → 401;
 *   3. per-token rate limit (Postgres fixed window)  → 429 + `Retry-After`;
 *   4. scope check (`admin` is a superscope)  → 403;
 *   5. success: attach `request.apiToken`, bump `last_used_at` (throttled), continue.
 *
 * Denials that involve a REAL, presented credential (unknown/revoked token, scope
 * refusal, rate-limit) are written to the audit trail as `auth.denied`. An absent
 * or malformed header is "unauthenticated", not a security event, and is not
 * audited (it would flood the ledger with anonymous-probe noise).
 *
 * This guard is the ONLY thing standing between a caller and the route; it has NO
 * bypass, and it never grants a privileged path around the engine-layer compliance
 * rails (I-RAIL-API) — a `write:leads` token is permission to ASK the send/enroll
 * engine, which still enforces suppression/DNC/window/cap itself.
 *
 * Import-safe for direct `node` execution (no enums / namespaces / parameter
 * properties — the host type-stripping constraint).
 */

// The authenticated identity rides on the request for downstream handlers/audit.
declare module 'fastify' {
  interface FastifyRequest {
    apiToken?: AuthenticatedToken;
  }
}

export interface BearerAuthDeps {
  db: Db;
  tokens: TokenService;
  rateLimiter: PostgresRateLimiter;
  /** last_used_at throttle window in ms (default 60s). */
  lastUsedThrottleMs?: number;
}

export interface BearerAuthOptions {
  /** The scope a caller must hold (directly or via `admin`) to pass. */
  scope: ApiScope;
}

/** Reasons worth an audit row (a real credential was presented and refused). */
const AUDITED_REASONS: ReadonlySet<DenialReason> = new Set<DenialReason>([
  'unknown_token',
  'revoked_or_expired',
  'insufficient_scope',
  'rate_limited',
]);

interface DenialContext {
  reason: DenialReason;
  code: ErrorCode;
  message: string;
  tokenId?: string | undefined;
  createdBy?: string | null | undefined;
  retryAfterSec?: number | undefined;
  details?: unknown;
}

async function deny(
  db: Db,
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: DenialContext,
): Promise<FastifyReply> {
  if (AUDITED_REASONS.has(ctx.reason)) {
    const actor = requestActor(request, { id: ctx.createdBy ?? null, type: 'api_token' });
    try {
      await writeAudit(db, {
        action: 'auth.denied',
        entity: 'api_token',
        entityId: ctx.tokenId ?? null,
        actorType: actor.actorType,
        actorId: actor.actorId,
        reason: ctx.reason,
        ip: actor.ip,
      });
    } catch (err) {
      // Auditing must never turn a safe denial into a 500.
      request.log?.error?.({ err }, 'auth.denied audit write failed');
    }
  }
  if (ctx.retryAfterSec !== undefined) reply.header('Retry-After', String(ctx.retryAfterSec));
  return sendError(reply, ctx.code, ctx.message, ctx.details);
}

export function createBearerAuthPreHandler(
  deps: BearerAuthDeps,
  options: BearerAuthOptions,
): preHandlerHookHandler {
  const throttleMs = deps.lastUsedThrottleMs ?? 60_000;

  return async (request, reply) => {
    // 1. Extract the bearer token.
    const authHeader = request.headers['authorization'];
    if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
      return deny(deps.db, request, reply, {
        reason: 'missing_token',
        code: 'UNAUTHENTICATED',
        message: 'a bearer token is required',
      });
    }
    const plaintext = authHeader.slice('Bearer '.length).trim();
    if (!looksLikeToken(plaintext)) {
      return deny(deps.db, request, reply, {
        reason: 'malformed_token',
        code: 'UNAUTHENTICATED',
        message: 'malformed bearer token',
      });
    }

    // 2. Authenticate (hash lookup + revoked/expired gate).
    const outcome = await deps.tokens.authenticate(plaintext);
    if (!outcome.ok) {
      return deny(deps.db, request, reply, {
        reason: outcome.reason,
        code: 'UNAUTHENTICATED',
        message:
          outcome.reason === 'revoked_or_expired'
            ? 'token has been revoked or has expired'
            : 'invalid token',
        tokenId: outcome.reason === 'unknown_token' ? undefined : outcome.tokenId,
        createdBy: outcome.reason === 'unknown_token' ? undefined : outcome.createdBy,
      });
    }
    const token = outcome.token;

    // 3. Per-token rate limit (before scope, so scope-probing still costs budget).
    const rl = await deps.rateLimiter.consumeToken(token.id);
    if (rl.limited) {
      return deny(deps.db, request, reply, {
        reason: 'rate_limited',
        code: 'RATE_LIMITED',
        message: 'rate limit exceeded',
        tokenId: token.id,
        createdBy: token.createdBy,
        retryAfterSec: rl.retryAfterSec,
        details: { limit: rl.limit, retryAfterSec: rl.retryAfterSec },
      });
    }

    // 4. Scope.
    if (!hasScope(token.scopes, options.scope)) {
      return deny(deps.db, request, reply, {
        reason: 'insufficient_scope',
        code: 'FORBIDDEN',
        message: `this token lacks the required scope: ${options.scope}`,
        tokenId: token.id,
        createdBy: token.createdBy,
        details: { requiredScope: options.scope },
      });
    }

    // 5. Success — attach identity, bump last_used_at (throttled, best-effort).
    request.apiToken = token;
    try {
      await deps.tokens.touchLastUsed(token.id, throttleMs);
    } catch (err) {
      request.log?.error?.({ err }, 'last_used_at update failed');
    }
    // Returning nothing lets the request continue to the route handler.
    return undefined;
  };
}

/** Resolve a session key (e.g. user id) from the request for the web limiter. */
export type SessionKeyResolver = (request: FastifyRequest) => string | null;

export interface SessionRateLimitDeps {
  rateLimiter: PostgresRateLimiter;
  /** Maps a request to its session key; null ⇒ the limiter is skipped. */
  sessionKeyFor: SessionKeyResolver;
}

/**
 * Per-session rate limiter for the web surface (generous default, configured via
 * the injected {@link PostgresRateLimiter}). Keyed by session, not token, so it is
 * independent of the bearer path. When no session key resolves it is a no-op (the
 * route's own auth decides what to do with an anonymous request).
 */
export function createSessionRateLimitPreHandler(
  deps: SessionRateLimitDeps,
): preHandlerHookHandler {
  return async (request, reply) => {
    const key = deps.sessionKeyFor(request);
    if (key === null) return undefined;
    const rl = await deps.rateLimiter.consumeSession(key);
    if (rl.limited) {
      reply.header('Retry-After', String(rl.retryAfterSec));
      return sendError(reply, 'RATE_LIMITED', 'rate limit exceeded', {
        limit: rl.limit,
        retryAfterSec: rl.retryAfterSec,
      });
    }
    return undefined;
  };
}
