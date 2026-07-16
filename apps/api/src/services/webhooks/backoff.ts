/**
 * Outbound webhook retry policy (Task 5c, ARCHITECTURE §5 "retried w/ backoff").
 *
 * A failed delivery is retried on a truncated-exponential schedule with jitter;
 * after {@link BackoffConfig.maxAttempts} total attempts it is dead-lettered (the
 * `webhook_deliveries` row goes terminal — see delivery.ts). Jitter spreads a
 * thundering herd of simultaneous failures so retries don't resynchronise.
 *
 * The pre-jitter CEILING is a pure function of the attempt number, so the schedule
 * is asserted exactly in tests; jitter is applied through an injected RNG so the
 * jittered value is deterministic under test too.
 *
 * Import-safe for direct `node` execution (no enums / namespaces / parameter
 * properties — the host type-stripping constraint).
 */

export interface BackoffConfig {
  /** Delay before the FIRST retry (attempt 1), in ms. */
  baseMs: number;
  /** Geometric growth factor per attempt. */
  factor: number;
  /** Ceiling the exponential is truncated to, in ms. */
  maxMs: number;
  /** Total delivery attempts before dead-lettering (initial try + retries). */
  maxAttempts: number;
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  baseMs: 1_000,
  factor: 2,
  maxMs: 3_600_000, // 1 hour cap
  maxAttempts: 6,
};

/**
 * Pre-jitter delay ceiling before the `attempt`-th retry (1-based): the initial
 * delivery is attempt 0, its first retry is attempt 1 (`baseMs`), the second is
 * attempt 2 (`baseMs*factor`), … truncated at `maxMs`.
 */
export function backoffCeilingMs(attempt: number, config: BackoffConfig = DEFAULT_BACKOFF): number {
  if (attempt < 1) return 0;
  const raw = config.baseMs * Math.pow(config.factor, attempt - 1);
  return Math.min(config.maxMs, Math.round(raw));
}

/**
 * Jittered retry delay for the `attempt`-th retry. Uses "equal jitter": half the
 * ceiling is fixed and half is random, so the result lies in
 * `[ceiling/2, ceiling]` — never zero (a retry always waits) yet still spread.
 * `rng` returns a value in [0, 1); default `Math.random`.
 */
export function nextRetryDelayMs(
  attempt: number,
  config: BackoffConfig = DEFAULT_BACKOFF,
  rng: () => number = Math.random,
): number {
  const ceiling = backoffCeilingMs(attempt, config);
  if (ceiling === 0) return 0;
  const half = ceiling / 2;
  return Math.round(half + rng() * half);
}

/**
 * True once `attempts` has reached `maxAttempts` — the delivery is out of retries
 * and must be dead-lettered.
 */
export function isDeadLettered(attempts: number, config: BackoffConfig = DEFAULT_BACKOFF): boolean {
  return attempts >= config.maxAttempts;
}
