/**
 * Token auth module barrel (Task 5c). The internal REST API's credential layer:
 * scoped bearer tokens (sha256-hashed, plaintext-once), a Postgres fixed-window
 * rate limiter, and the Fastify preHandler that enforces both — auditing every
 * refusal through `services/audit`.
 */

export {
  API_SCOPES,
  ADMIN_SCOPE,
  apiScopeSchema,
  hasScope,
  isApiScope,
  parseScopes,
  type ApiScope,
} from './scopes.ts';

export {
  TOKEN_PREFIX,
  generateTokenPlaintext,
  hashToken,
  hashesEqual,
  looksLikeToken,
} from './hash.ts';

export {
  TokenError,
  TokenValidationError,
  TokenNotFoundError,
  type DenialReason,
} from './errors.ts';

export {
  TokenService,
  type ApiTokenView,
  type CreateTokenInput,
  type CreatedToken,
  type AuthenticatedToken,
  type AuthOutcome,
  type ListTokensFilter,
  type ListTokensPage,
} from './service.ts';

export {
  DEFAULT_RATE_LIMITS,
  PostgresRateLimiter,
  consumeRateLimit,
  ensureRateLimitSchema,
  sessionBucket,
  tokenBucket,
  type RateLimitConfig,
  type RateLimitResult,
  type RateLimitRule,
} from './rate-limit.ts';

export {
  createBearerAuthPreHandler,
  createSessionRateLimitPreHandler,
  type BearerAuthDeps,
  type BearerAuthOptions,
  type SessionKeyResolver,
  type SessionRateLimitDeps,
} from './pre-handler.ts';
