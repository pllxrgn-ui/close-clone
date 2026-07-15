import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Twilio request-signature scheme (HMAC-SHA1 over URL + sorted params), shared by
 * the mock's `verifyWebhook` (CONTRACTS §C2: MUST run on every ingress) and the
 * recorded-fixture signer. Real Twilio uses the account auth token as the HMAC
 * key; the mock uses `MOCK_TWILIO_AUTH_TOKEN`.
 *
 * Scheme (form-encoded POST): take the full request URL, then append every POST
 * parameter as `name + value` (no separators) in ascending name order, HMAC-SHA1
 * with the auth token, base64-encode. Verification recomputes and compares in
 * constant time. This module is standalone (Node `crypto` only) so it is trivially
 * unit-testable against Twilio's published test vector.
 */

/** Header Twilio delivers the signature in (matched case-insensitively on ingress). */
export const TWILIO_SIGNATURE_HEADER = 'X-Twilio-Signature';

/** Default HMAC key for MOCK_MODE fixtures/tests (no real Twilio account). */
export const MOCK_TWILIO_AUTH_TOKEN = 'mock-twilio-auth-token';

/**
 * The exact string Twilio signs for a form POST: the request URL followed by each
 * parameter appended as `name + value` in ascending name order, no separators.
 */
export function twilioSignatureBaseString(url: string, params: Record<string, string>): string {
  const entries = Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  let acc = url;
  for (const [name, value] of entries) {
    acc += name + value;
  }
  return acc;
}

/** Base64 HMAC-SHA1 signature for a form POST (Twilio's scheme). */
export function signTwilioForm(
  url: string,
  params: Record<string, string>,
  authToken: string,
): string {
  return createHmac('sha1', authToken)
    .update(twilioSignatureBaseString(url, params), 'utf8')
    .digest('base64');
}

/** Parse an `application/x-www-form-urlencoded` body into a decoded param map. */
export function parseFormBody(rawBody: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [name, value] of new URLSearchParams(rawBody)) {
    params[name] = value;
  }
  return params;
}

/** Constant-time compare; unequal lengths short-circuit to false (never throws). */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Case-insensitive header lookup (ingress header casing is not guaranteed). */
export function readHeader(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

/**
 * Verify an `X-Twilio-Signature` over a form-encoded body. Returns false — never
 * throws — for a missing/blank signature, a tampered body/url, or a wrong key, so
 * both the accept and reject ingress paths are exercisable.
 */
export function verifyTwilioSignature(
  url: string,
  rawBody: string,
  signature: string | undefined,
  authToken: string,
): boolean {
  if (signature === undefined || signature.length === 0) return false;
  const expected = signTwilioForm(url, parseFormBody(rawBody), authToken);
  return constantTimeEqual(expected, signature);
}
