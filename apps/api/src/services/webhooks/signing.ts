import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Outbound webhook HMAC signing (Task 5c, ARCHITECTURE §5 "HMAC-signed, retried").
 *
 * Every delivery carries a signature header a receiver verifies to prove (a) the
 * payload came from Switchboard and (b) it is fresh (anti-replay):
 *
 *     X-Switchboard-Signature: t=<unixSeconds>,v1=<hex hmac-sha256(secret, "t.body")>
 *
 * The signed string is `"${t}.${body}"` — binding the timestamp INTO the MAC is
 * what makes `t` tamper-evident, so an attacker cannot replay an old body under a
 * fresh timestamp. Scheme is Stripe/Svix-compatible so off-the-shelf verifiers
 * work.
 *
 * REPLAY WINDOW (normative for receivers): a signature whose `t` differs from the
 * receiver's clock by more than {@link DEFAULT_REPLAY_TOLERANCE_SEC} (5 minutes)
 * MUST be rejected even if the MAC is valid. This bounds a captured-request replay
 * to a 5-minute window; pair it with delivery-id idempotency for exactly-once.
 *
 * The subscription secret is NEVER logged or exported (CONTRACTS D-021) — it lives
 * only in `webhook_subscriptions.secret` and this module's HMAC input.
 *
 * Import-safe for direct `node` execution (no enums / namespaces / parameter
 * properties — the host type-stripping constraint).
 */

/** Lower-cased HTTP header name carrying the signature. */
export const SIGNATURE_HEADER = 'x-switchboard-signature';

/** Receiver-side freshness tolerance, in seconds (5 minutes each way). */
export const DEFAULT_REPLAY_TOLERANCE_SEC = 300;

/** The `v1` scheme MAC: hex HMAC-SHA256 over `"${timestampSec}.${body}"`. */
export function computeSignature(secret: string, timestampSec: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestampSec}.${body}`, 'utf8').digest('hex');
}

/** Build the full header value `t=<ts>,v1=<mac>`. */
export function buildSignatureHeader(secret: string, timestampSec: number, body: string): string {
  return `t=${timestampSec},v1=${computeSignature(secret, timestampSec, body)}`;
}

export interface ParsedSignature {
  t: number;
  v1: string;
}

/** Parse `t=...,v1=...` (order-independent). Returns null on any malformation. */
export function parseSignatureHeader(header: string): ParsedSignature | null {
  let t: number | undefined;
  let v1: string | undefined;
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      if (!/^\d+$/.test(value)) return null;
      t = Number(value);
    } else if (key === 'v1') {
      if (!/^[0-9a-f]+$/i.test(value)) return null;
      v1 = value.toLowerCase();
    }
  }
  if (t === undefined || v1 === undefined) return null;
  return { t, v1 };
}

export interface VerifyOptions {
  /** Freshness tolerance in seconds; default {@link DEFAULT_REPLAY_TOLERANCE_SEC}. */
  toleranceSec?: number;
  /** Injected clock (unix ms); default `Date.now`. */
  nowMs?: () => number;
}

/**
 * Verify a signature header against `body` and `secret`. Returns true iff the MAC
 * matches (constant-time) AND the timestamp is within tolerance. This is the
 * receiver's check; we ship it so the round-trip is testable and so an internal
 * consumer can reuse it.
 */
export function verifySignature(
  secret: string,
  header: string,
  body: string,
  options: VerifyOptions = {},
): boolean {
  const parsed = parseSignatureHeader(header);
  if (parsed === null) return false;

  const toleranceSec = options.toleranceSec ?? DEFAULT_REPLAY_TOLERANCE_SEC;
  const nowMs = options.nowMs ?? Date.now;
  const skewSec = Math.abs(Math.floor(nowMs() / 1000) - parsed.t);
  if (skewSec > toleranceSec) return false;

  const expected = computeSignature(secret, parsed.t, body);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(parsed.v1, 'utf8');
  // Different length ⇒ not equal; timingSafeEqual throws on length mismatch.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
