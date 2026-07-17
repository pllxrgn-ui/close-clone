import { describe, expect, test } from 'vitest';

import { assertRealModeConfig } from './main.ts';
import { loadConfig } from './config.ts';

/*
 * Composition-root guarantees that do NOT need infra. The wiring itself (real
 * pg pool + BullMQ + the global session gate) is proven against real Postgres
 * and Redis by deploy/VERIFY.md, because asserting it here would need both
 * services — see that script for the end-to-end evidence.
 *
 * What is pinned here is the fail-closed posture: the single worst outcome for
 * this product is booting real mode with no IdP, which would serve the whole
 * API with no way to authenticate anyone.
 */

const REAL = { MOCK_MODE: '0', SESSION_SECRET: 'x'.repeat(40) } as const;

describe('assertRealModeConfig — fail closed without an IdP', () => {
  test('MOCK_MODE=1 needs no OIDC config (the zero-account path, guide §4.6)', () => {
    const env = { MOCK_MODE: '1' } as NodeJS.ProcessEnv;
    expect(() => assertRealModeConfig(loadConfig(env), env)).not.toThrow();
  });

  test('MOCK_MODE=0 with no OIDC config refuses to boot', () => {
    const env = { ...REAL } as NodeJS.ProcessEnv;
    expect(() => assertRealModeConfig(loadConfig(env), env)).toThrow(/OIDC_ISSUER/);
  });

  // failure path: a half-configured IdP is still a refusal, and the message
  // names exactly what is missing rather than the whole list.
  test('MOCK_MODE=0 with a partial IdP config names only the missing keys', () => {
    const env = {
      ...REAL,
      OIDC_ISSUER: 'https://accounts.example.com',
      OIDC_CLIENT_ID: 'switchboard',
    } as NodeJS.ProcessEnv;
    expect(() => assertRealModeConfig(loadConfig(env), env)).toThrow(/OIDC_CLIENT_SECRET/);
    expect(() => assertRealModeConfig(loadConfig(env), env)).not.toThrow(/OIDC_ISSUER,/);
  });

  test('blank strings count as unset (an empty .env line is not configuration)', () => {
    const env = {
      ...REAL,
      OIDC_ISSUER: '  ',
      OIDC_CLIENT_ID: '',
      OIDC_CLIENT_SECRET: '',
    } as NodeJS.ProcessEnv;
    expect(() => assertRealModeConfig(loadConfig(env), env)).toThrow(/OIDC_ISSUER/);
  });

  test('a fully configured IdP passes the gate', () => {
    const env = {
      ...REAL,
      OIDC_ISSUER: 'https://accounts.example.com',
      OIDC_CLIENT_ID: 'switchboard',
      OIDC_CLIENT_SECRET: 'shh',
    } as NodeJS.ProcessEnv;
    expect(() => assertRealModeConfig(loadConfig(env), env)).not.toThrow();
  });
});
