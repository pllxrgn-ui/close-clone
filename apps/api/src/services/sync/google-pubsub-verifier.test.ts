import { generateKeyPairSync } from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { signCompactJws } from '../../auth/oidc/jwt.ts';
import type { HttpTransport } from '../../auth/oidc/transport.ts';
import { GooglePubSubPushVerifier } from './webhook.ts';

const NOW = new Date('2026-07-20T09:00:00.000Z');
const NOW_SEC = Math.floor(NOW.getTime() / 1000);
const AUDIENCE = 'https://switchboard.example.com/wh/gmail';
const SERVICE_ACCOUNT = 'pubsub@switchboard.iam.gserviceaccount.com';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;

const rawBody = JSON.stringify({
  message: {
    data: Buffer.from(
      JSON.stringify({ emailAddress: 'sales@example.com', historyId: '1001' }),
    ).toString('base64'),
    messageId: 'pubsub-event-1',
  },
});

const transport: HttpTransport = {
  async getJson() {
    return { keys: [{ ...publicJwk, kid: 'google-key', alg: 'RS256', use: 'sig' }] };
  },
  async postForm() {
    throw new Error('not used');
  },
};

function token(overrides: Record<string, unknown> = {}): string {
  return signCompactJws(
    { alg: 'RS256', kid: 'google-key' },
    {
      iss: 'https://accounts.google.com',
      sub: 'service-account-subject',
      aud: AUDIENCE,
      exp: NOW_SEC + 3600,
      iat: NOW_SEC,
      email: SERVICE_ACCOUNT,
      email_verified: true,
      ...overrides,
    },
    privateKey,
    'RS256',
  );
}

function verifier(): GooglePubSubPushVerifier {
  return new GooglePubSubPushVerifier({
    audience: AUDIENCE,
    serviceAccountEmail: SERVICE_ACCOUNT,
    transport,
    now: () => NOW,
  });
}

describe('GooglePubSubPushVerifier', () => {
  test('accepts a signed Google token with the configured audience and service account', async () => {
    await expect(verifier().verify({ authorization: `Bearer ${token()}` }, rawBody)).resolves.toBe(
      true,
    );
  });

  test.each([
    ['wrong audience', { aud: 'https://attacker.example/wh/gmail' }],
    ['wrong service account', { email: 'attacker@example.com' }],
    ['unverified service account', { email_verified: false }],
    ['expired token', { exp: NOW_SEC - 120 }],
    ['future token', { iat: NOW_SEC + 120 }],
    ['wrong issuer', { iss: 'https://attacker.example' }],
  ])('rejects %s', async (_label, overrides) => {
    await expect(
      verifier().verify({ authorization: `Bearer ${token(overrides)}` }, rawBody),
    ).resolves.toBe(false);
  });

  test('rejects a missing bearer token or malformed push envelope', async () => {
    await expect(verifier().verify({}, rawBody)).resolves.toBe(false);
    await expect(
      verifier().verify({ authorization: `Bearer ${token()}` }, '{"not":"pubsub"}'),
    ).resolves.toBe(false);
  });
});
