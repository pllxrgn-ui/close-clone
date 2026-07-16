import type { JsonWebKey } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import {
  decodeJwt,
  importRsaJwk,
  isSupportedAlg,
  JwtMalformedError,
  verifyJwsSignature,
} from './jwt.ts';
import { LocalOidcIssuer } from '../testing/local-oidc-issuer.ts';

/**
 * Task 5a — compact-JWS crypto foundation. Proves real RSA signatures round-trip
 * and, crucially, that the failure paths fail closed: tampered signature, tampered
 * payload, unsupported/confused alg, malformed token.
 */

describe('alg allow-list', () => {
  test('accepts RS256/384/512 only', () => {
    expect(isSupportedAlg('RS256')).toBe(true);
    expect(isSupportedAlg('RS384')).toBe(true);
    expect(isSupportedAlg('RS512')).toBe(true);
  });
  test('rejects none, HS256, ES256 (alg-confusion defense)', () => {
    expect(isSupportedAlg('none')).toBe(false);
    expect(isSupportedAlg('HS256')).toBe(false);
    expect(isSupportedAlg('ES256')).toBe(false);
  });
});

describe('sign → verify round trip', () => {
  const issuer = new LocalOidcIssuer();

  test('a genuine token verifies against its JWKS key', () => {
    const token = issuer.signIdToken({ sub: 'u1', aud: 'client', nonce: 'n' });
    const decoded = decodeJwt(token);
    expect(decoded.header.alg).toBe('RS256');
    expect(decoded.header.kid).toBe('key-1');
    expect(decoded.payload['sub']).toBe('u1');

    const jwk = issuer.jwks().keys.find((k) => k.kid === decoded.header.kid);
    expect(jwk).toBeDefined();
    const key = importRsaJwk(jwk as JsonWebKey);
    expect(verifyJwsSignature(decoded, key)).toBe(true);
  });

  test('a tampered signature fails verification', () => {
    const token = issuer.signIdToken({ sub: 'u1', aud: 'client' });
    const parts = token.split('.');
    // Flip the FIRST signature char — always a significant high-order byte (a
    // trailing char can encode only padding bits and decode to identical bytes).
    const sig = parts[2] as string;
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    const decoded = decodeJwt(`${parts[0]}.${parts[1]}.${flipped}`);
    const jwk = issuer.jwks().keys[0] as JsonWebKey;
    expect(verifyJwsSignature(decoded, importRsaJwk(jwk))).toBe(false);
  });

  test('a tampered payload (re-based64) fails verification', () => {
    const token = issuer.signIdToken({ sub: 'u1', aud: 'client' });
    const parts = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ sub: 'attacker', aud: 'client' })).toString(
      'base64url',
    );
    const decoded = decodeJwt(`${parts[0]}.${forgedPayload}.${parts[2]}`);
    const jwk = issuer.jwks().keys[0] as JsonWebKey;
    expect(verifyJwsSignature(decoded, importRsaJwk(jwk))).toBe(false);
  });

  test('verifying a decoded token under an unsupported alg header returns false', () => {
    const token = issuer.signIdToken({ sub: 'u1', aud: 'client' });
    const decoded = decodeJwt(token);
    const confused = { ...decoded, header: { ...decoded.header, alg: 'HS256' } };
    const jwk = issuer.jwks().keys[0] as JsonWebKey;
    expect(verifyJwsSignature(confused, importRsaJwk(jwk))).toBe(false);
  });
});

describe('decodeJwt malformed input', () => {
  test('wrong segment count throws', () => {
    expect(() => decodeJwt('a.b')).toThrow(JwtMalformedError);
    expect(() => decodeJwt('a.b.c.d')).toThrow(JwtMalformedError);
  });
  test('non-JSON header throws', () => {
    const bad = `${Buffer.from('not json').toString('base64url')}.${Buffer.from('{}').toString('base64url')}.sig`;
    expect(() => decodeJwt(bad)).toThrow(JwtMalformedError);
  });
  test('header without alg throws', () => {
    const h = Buffer.from(JSON.stringify({ kid: 'x' })).toString('base64url');
    const p = Buffer.from(JSON.stringify({})).toString('base64url');
    expect(() => decodeJwt(`${h}.${p}.sig`)).toThrow(JwtMalformedError);
  });
});

describe('importRsaJwk', () => {
  test('rejects a non-RSA JWK', () => {
    expect(() => importRsaJwk({ kty: 'oct', k: 'AAAA' } as JsonWebKey)).toThrow(JwtMalformedError);
  });
});
