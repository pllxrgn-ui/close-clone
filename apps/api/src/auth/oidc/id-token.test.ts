import { describe, expect, test } from 'vitest';

import { IdTokenInvalidError, verifyIdToken, type IdTokenRejectReason } from './id-token.ts';
import { JwksCache } from './jwks.ts';
import { LocalOidcIssuer } from '../testing/local-oidc-issuer.ts';

/**
 * Task 5a — ID-token verification failure paths (acceptance list: tampered ID
 * token, wrong nonce, expired JWKS kid) plus the rest of the fail-closed matrix.
 */

const CLIENT = 'switchboard-web';
const NONCE = 'nonce-abc';
const FIXED_NOW = Date.parse('2026-07-15T12:00:00.000Z');
const now = (): Date => new Date(FIXED_NOW);
const nowSec = Math.floor(FIXED_NOW / 1000);

function jwksFor(issuer: LocalOidcIssuer): JwksCache {
  // minRefetchMs:0 so miss-driven refetch is observable under the frozen clock;
  // the anti-DoS floor is exercised directly in jwks.test.ts.
  return new JwksCache(issuer.jwksUri, { transport: issuer.transport(), now, minRefetchMs: 0 });
}

async function expectReject(p: Promise<unknown>, reason: IdTokenRejectReason): Promise<void> {
  await expect(p).rejects.toMatchObject({ reason });
  await expect(p).rejects.toBeInstanceOf(IdTokenInvalidError);
}

describe('happy path', () => {
  test('a genuine token yields validated claims', async () => {
    const issuer = new LocalOidcIssuer({ now });
    const token = issuer.signIdToken({
      sub: 'google|1',
      aud: CLIENT,
      nonce: NONCE,
      email: 'rep@corp.test',
      name: 'Rep One',
      groups: ['sales-crm-users'],
    });
    const claims = await verifyIdToken({
      token,
      issuer: issuer.issuer,
      audience: CLIENT,
      nonce: NONCE,
      jwks: jwksFor(issuer),
      now,
    });
    expect(claims.sub).toBe('google|1');
    expect(claims.email).toBe('rep@corp.test');
    expect(claims.groups).toEqual(['sales-crm-users']);
  });

  test('accepts an array aud when azp matches the client id', async () => {
    const issuer = new LocalOidcIssuer({ now });
    const token = issuer.signIdToken({
      sub: 's',
      aud: [CLIENT, 'other'],
      nonce: NONCE,
      extra: { azp: CLIENT },
    });
    const claims = await verifyIdToken({
      token,
      issuer: issuer.issuer,
      audience: CLIENT,
      nonce: NONCE,
      jwks: jwksFor(issuer),
      now,
    });
    expect(claims.sub).toBe('s');
  });
});

describe('multi-audience azp (OIDC core)', () => {
  test('array aud with a mismatched azp → azp_mismatch', async () => {
    const issuer = new LocalOidcIssuer({ now });
    const token = issuer.signIdToken({
      sub: 's',
      aud: [CLIENT, 'other'],
      nonce: NONCE,
      extra: { azp: 'other' },
    });
    await expectReject(
      verifyIdToken({
        token,
        issuer: issuer.issuer,
        audience: CLIENT,
        nonce: NONCE,
        jwks: jwksFor(issuer),
        now,
      }),
      'azp_mismatch',
    );
  });

  test('array aud with a missing azp → azp_mismatch', async () => {
    const issuer = new LocalOidcIssuer({ now });
    const token = issuer.signIdToken({ sub: 's', aud: [CLIENT, 'other'], nonce: NONCE });
    await expectReject(
      verifyIdToken({
        token,
        issuer: issuer.issuer,
        audience: CLIENT,
        nonce: NONCE,
        jwks: jwksFor(issuer),
        now,
      }),
      'azp_mismatch',
    );
  });

  test('single-string aud is still accepted without azp', async () => {
    const issuer = new LocalOidcIssuer({ now });
    const token = issuer.signIdToken({ sub: 's', aud: CLIENT, nonce: NONCE });
    const claims = await verifyIdToken({
      token,
      issuer: issuer.issuer,
      audience: CLIENT,
      nonce: NONCE,
      jwks: jwksFor(issuer),
      now,
    });
    expect(claims.sub).toBe('s');
  });
});

describe('signature + structure', () => {
  test('tampered signature → bad_signature', async () => {
    const issuer = new LocalOidcIssuer({ now });
    const token = issuer.signIdToken({ sub: 's', aud: CLIENT, nonce: NONCE });
    const parts = token.split('.');
    const sig = parts[2] as string;
    // Flip the first (always-significant) signature char — see jwt.test.ts note.
    const tampered = `${parts[0]}.${parts[1]}.${sig[0] === 'A' ? 'B' : 'A'}${sig.slice(1)}`;
    await expectReject(
      verifyIdToken({
        token: tampered,
        issuer: issuer.issuer,
        audience: CLIENT,
        nonce: NONCE,
        jwks: jwksFor(issuer),
        now,
      }),
      'bad_signature',
    );
  });

  test('tampered payload (attacker rewrites sub) → bad_signature', async () => {
    const issuer = new LocalOidcIssuer({ now });
    const token = issuer.signIdToken({ sub: 'victim', aud: CLIENT, nonce: NONCE });
    const parts = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({
        iss: issuer.issuer,
        sub: 'attacker',
        aud: CLIENT,
        exp: nowSec + 60,
        iat: nowSec,
        nonce: NONCE,
      }),
    ).toString('base64url');
    await expectReject(
      verifyIdToken({
        token: `${parts[0]}.${forged}.${parts[2]}`,
        issuer: issuer.issuer,
        audience: CLIENT,
        nonce: NONCE,
        jwks: jwksFor(issuer),
        now,
      }),
      'bad_signature',
    );
  });

  test("alg 'none' header → unsupported_alg (never verifies unsigned)", async () => {
    const issuer = new LocalOidcIssuer({ now });
    const header = Buffer.from(JSON.stringify({ alg: 'none', kid: 'key-1' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: issuer.issuer,
        sub: 's',
        aud: CLIENT,
        exp: nowSec + 60,
        iat: nowSec,
        nonce: NONCE,
      }),
    ).toString('base64url');
    // Non-empty dummy signature so the alg allow-list (not the empty-segment
    // structural guard) is what rejects it.
    await expectReject(
      verifyIdToken({
        token: `${header}.${payload}.AAAA`,
        issuer: issuer.issuer,
        audience: CLIENT,
        nonce: NONCE,
        jwks: jwksFor(issuer),
        now,
      }),
      'unsupported_alg',
    );
  });

  test('supported alg but missing kid → missing_kid', async () => {
    const issuer = new LocalOidcIssuer({ now });
    const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 's' })).toString('base64url');
    await expectReject(
      verifyIdToken({
        token: `${header}.${payload}.AAAA`,
        issuer: issuer.issuer,
        audience: CLIENT,
        nonce: NONCE,
        jwks: jwksFor(issuer),
        now,
      }),
      'missing_kid',
    );
  });
});

describe('claims', () => {
  const base = { sub: 's', aud: CLIENT, nonce: NONCE } as const;

  test('wrong nonce → nonce_mismatch', async () => {
    const issuer = new LocalOidcIssuer({ now });
    const token = issuer.signIdToken({ ...base, nonce: 'a-different-nonce' });
    await expectReject(
      verifyIdToken({
        token,
        issuer: issuer.issuer,
        audience: CLIENT,
        nonce: NONCE,
        jwks: jwksFor(issuer),
        now,
      }),
      'nonce_mismatch',
    );
  });

  test('missing nonce → nonce_mismatch', async () => {
    const issuer = new LocalOidcIssuer({ now });
    const token = issuer.signIdToken({ sub: 's', aud: CLIENT });
    await expectReject(
      verifyIdToken({
        token,
        issuer: issuer.issuer,
        audience: CLIENT,
        nonce: NONCE,
        jwks: jwksFor(issuer),
        now,
      }),
      'nonce_mismatch',
    );
  });

  test('expired beyond skew → expired', async () => {
    const issuer = new LocalOidcIssuer({ now });
    const token = issuer.signIdToken({ ...base, iat: nowSec - 3600, exp: nowSec - 120 });
    await expectReject(
      verifyIdToken({
        token,
        issuer: issuer.issuer,
        audience: CLIENT,
        nonce: NONCE,
        jwks: jwksFor(issuer),
        now,
      }),
      'expired',
    );
  });

  test('expired but within clock-skew tolerance → accepted', async () => {
    const issuer = new LocalOidcIssuer({ now });
    const token = issuer.signIdToken({ ...base, iat: nowSec - 3600, exp: nowSec - 30 });
    const claims = await verifyIdToken({
      token,
      issuer: issuer.issuer,
      audience: CLIENT,
      nonce: NONCE,
      jwks: jwksFor(issuer),
      now,
      clockSkewSec: 60,
    });
    expect(claims.sub).toBe('s');
  });

  test('issued in the future beyond skew → issued_in_future', async () => {
    const issuer = new LocalOidcIssuer({ now });
    const token = issuer.signIdToken({ ...base, iat: nowSec + 600, exp: nowSec + 4200 });
    await expectReject(
      verifyIdToken({
        token,
        issuer: issuer.issuer,
        audience: CLIENT,
        nonce: NONCE,
        jwks: jwksFor(issuer),
        now,
      }),
      'issued_in_future',
    );
  });

  test('wrong issuer → issuer_mismatch', async () => {
    const issuer = new LocalOidcIssuer({ now });
    const token = issuer.signIdToken({ ...base, iss: 'https://evil.test' });
    await expectReject(
      verifyIdToken({
        token,
        issuer: issuer.issuer,
        audience: CLIENT,
        nonce: NONCE,
        jwks: jwksFor(issuer),
        now,
      }),
      'issuer_mismatch',
    );
  });

  test('wrong audience → audience_mismatch', async () => {
    const issuer = new LocalOidcIssuer({ now });
    const token = issuer.signIdToken({ sub: 's', aud: 'someone-else', nonce: NONCE });
    await expectReject(
      verifyIdToken({
        token,
        issuer: issuer.issuer,
        audience: CLIENT,
        nonce: NONCE,
        jwks: jwksFor(issuer),
        now,
      }),
      'audience_mismatch',
    );
  });
});

describe('JWKS key rotation', () => {
  test('a rotated-IN key is picked up on refetch → verifies', async () => {
    const issuer = new LocalOidcIssuer({ now });
    const jwks = jwksFor(issuer);
    // Prime the cache with key-1.
    await jwks.getKey('key-1');
    // Rotate to key-2 (key-1 unpublished) and sign a fresh token with key-2.
    issuer.rotateKey('key-2');
    const token = issuer.signIdToken({ sub: 's', aud: CLIENT, nonce: NONCE, kid: 'key-2' });
    const claims = await verifyIdToken({
      token,
      issuer: issuer.issuer,
      audience: CLIENT,
      nonce: NONCE,
      jwks,
      now,
      // allow the miss-driven refetch immediately
    });
    expect(claims.sub).toBe('s');
  });

  test('a token bearing a rotated-OUT (expired) kid → unknown_kid', async () => {
    const issuer = new LocalOidcIssuer({ now });
    // Sign while key-1 is active, capture the token.
    const token = issuer.signIdToken({ sub: 's', aud: CLIENT, nonce: NONCE, kid: 'key-1' });
    // Rotate key-1 out of the JWKS.
    issuer.rotateKey('key-2');
    const jwks = new JwksCache(issuer.jwksUri, {
      transport: issuer.transport(),
      now,
      minRefetchMs: 0,
    });
    await expectReject(
      verifyIdToken({ token, issuer: issuer.issuer, audience: CLIENT, nonce: NONCE, jwks, now }),
      'unknown_kid',
    );
  });
});
