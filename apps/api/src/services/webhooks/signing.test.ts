import { describe, expect, test } from 'vitest';

import {
  DEFAULT_REPLAY_TOLERANCE_SEC,
  buildSignatureHeader,
  computeSignature,
  parseSignatureHeader,
  verifySignature,
} from './signing.ts';

/**
 * Task 5c — HMAC signing. Round-trip, tamper detection, and the documented replay
 * window (CONTRACTS §C6 spirit: signature-verified ingress; here we ship the
 * verifier so the round-trip is provable and reusable).
 */

const SECRET = 'whsec_test_0123456789';
const BODY = JSON.stringify({ id: 'evt_1', type: 'lead.created', data: { leadId: 'L1' } });
const T = 1_800_000_000; // fixed unix seconds
const nowMs = () => T * 1000;

describe('header format', () => {
  test('buildSignatureHeader emits t=<ts>,v1=<hex hmac>', () => {
    const header = buildSignatureHeader(SECRET, T, BODY);
    expect(header).toBe(`t=${T},v1=${computeSignature(SECRET, T, BODY)}`);
    const parsed = parseSignatureHeader(header);
    expect(parsed).toEqual({ t: T, v1: computeSignature(SECRET, T, BODY) });
  });

  test('computeSignature binds the timestamp into the MAC', () => {
    // Same body, different timestamp ⇒ different signature (replay-resistance).
    expect(computeSignature(SECRET, T, BODY)).not.toBe(computeSignature(SECRET, T + 1, BODY));
  });

  test('parseSignatureHeader rejects malformed headers', () => {
    expect(parseSignatureHeader('garbage')).toBeNull();
    expect(parseSignatureHeader('t=abc,v1=deadbeef')).toBeNull(); // non-numeric t
    expect(parseSignatureHeader('t=123,v1=nothex!!')).toBeNull();
    expect(parseSignatureHeader('v1=deadbeef')).toBeNull(); // missing t
    expect(parseSignatureHeader(`t=${T}`)).toBeNull(); // missing v1
  });
});

describe('verifySignature — round trip', () => {
  test('a freshly built header verifies', () => {
    const header = buildSignatureHeader(SECRET, T, BODY);
    expect(verifySignature(SECRET, header, BODY, { nowMs })).toBe(true);
  });
});

describe('verifySignature — tamper detection', () => {
  const header = buildSignatureHeader(SECRET, T, BODY);

  test('a modified body fails', () => {
    expect(verifySignature(SECRET, header, BODY + ' ', { nowMs })).toBe(false);
  });

  test('a wrong secret fails', () => {
    expect(verifySignature('whsec_attacker', header, BODY, { nowMs })).toBe(false);
  });

  test('a flipped signature byte fails', () => {
    const parsed = parseSignatureHeader(header)!;
    const firstChar = parsed.v1[0] === 'a' ? 'b' : 'a';
    const tampered = `t=${parsed.t},v1=${firstChar}${parsed.v1.slice(1)}`;
    expect(verifySignature(SECRET, tampered, BODY, { nowMs })).toBe(false);
  });

  test('a truncated signature (length mismatch) fails without throwing', () => {
    const parsed = parseSignatureHeader(header)!;
    const tampered = `t=${parsed.t},v1=${parsed.v1.slice(0, 10)}`;
    expect(verifySignature(SECRET, tampered, BODY, { nowMs })).toBe(false);
  });
});

describe('verifySignature — replay window', () => {
  const header = buildSignatureHeader(SECRET, T, BODY);

  test('within tolerance passes', () => {
    const later = () => (T + DEFAULT_REPLAY_TOLERANCE_SEC) * 1000;
    expect(verifySignature(SECRET, header, BODY, { nowMs: later })).toBe(true);
  });

  test('one second past tolerance fails even with a valid MAC', () => {
    const tooLate = () => (T + DEFAULT_REPLAY_TOLERANCE_SEC + 1) * 1000;
    expect(verifySignature(SECRET, header, BODY, { nowMs: tooLate })).toBe(false);
  });

  test('a far-future (clock-skew) timestamp also fails', () => {
    const earlier = () => (T - DEFAULT_REPLAY_TOLERANCE_SEC - 1) * 1000;
    expect(verifySignature(SECRET, header, BODY, { nowMs: earlier })).toBe(false);
  });
});
