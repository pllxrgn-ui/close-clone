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
const COMPLETE_PRODUCTION_ENV = {
  ...REAL,
  OIDC_ISSUER: 'https://accounts.example.com',
  OIDC_CLIENT_ID: 'switchboard',
  OIDC_CLIENT_SECRET: 'oidc-secret',
  WEB_ORIGIN: 'https://switchboard.example.com',
  PUBLIC_WEBHOOK_URL: 'https://switchboard-api.example.com',
  GOOGLE_CLIENT_ID: 'google-client',
  GOOGLE_CLIENT_SECRET: 'google-secret',
  GMAIL_PUSH_AUDIENCE: 'https://switchboard.example.com/wh/gmail',
  GMAIL_PUSH_SERVICE_ACCOUNT_EMAIL: 'pubsub@project.iam.gserviceaccount.com',
  TWILIO_ACCOUNT_SID: 'AC123',
  TWILIO_AUTH_TOKEN: 'twilio-secret',
  TWILIO_API_KEY_SID: 'SK123',
  TWILIO_API_KEY_SECRET: 'twilio-api-secret',
  TWILIO_TWIML_APP_SID: 'AP123',
  TWILIO_PHONE_NUMBER: '+12065550100',
  DEEPGRAM_API_KEY: 'deepgram-secret',
  ANTHROPIC_API_KEY: 'anthropic-secret',
} as const;

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

  test('a fully configured production stack passes the gate', () => {
    const env = { ...COMPLETE_PRODUCTION_ENV } as NodeJS.ProcessEnv;
    expect(() => assertRealModeConfig(loadConfig(env), env)).not.toThrow();
  });

  test('production core boots before optional provider accounts are available', () => {
    const env = {
      ...REAL,
      OIDC_ISSUER: COMPLETE_PRODUCTION_ENV.OIDC_ISSUER,
      OIDC_CLIENT_ID: COMPLETE_PRODUCTION_ENV.OIDC_CLIENT_ID,
      OIDC_CLIENT_SECRET: COMPLETE_PRODUCTION_ENV.OIDC_CLIENT_SECRET,
      WEB_ORIGIN: COMPLETE_PRODUCTION_ENV.WEB_ORIGIN,
      PUBLIC_WEBHOOK_URL: COMPLETE_PRODUCTION_ENV.PUBLIC_WEBHOOK_URL,
    } as NodeJS.ProcessEnv;
    expect(() => assertRealModeConfig(loadConfig(env), env)).not.toThrow();
  });

  test('a partially configured provider group refuses to boot with the missing keys', () => {
    const env = {
      ...REAL,
      OIDC_ISSUER: COMPLETE_PRODUCTION_ENV.OIDC_ISSUER,
      OIDC_CLIENT_ID: COMPLETE_PRODUCTION_ENV.OIDC_CLIENT_ID,
      OIDC_CLIENT_SECRET: COMPLETE_PRODUCTION_ENV.OIDC_CLIENT_SECRET,
      WEB_ORIGIN: COMPLETE_PRODUCTION_ENV.WEB_ORIGIN,
      PUBLIC_WEBHOOK_URL: COMPLETE_PRODUCTION_ENV.PUBLIC_WEBHOOK_URL,
      TWILIO_ACCOUNT_SID: COMPLETE_PRODUCTION_ENV.TWILIO_ACCOUNT_SID,
    } as NodeJS.ProcessEnv;
    expect(() => assertRealModeConfig(loadConfig(env), env)).toThrow(/TWILIO_API_KEY_SECRET/);
  });

  test('a partial Gmail group is rejected without affecting an entirely absent group', () => {
    const env = {
      ...REAL,
      OIDC_ISSUER: COMPLETE_PRODUCTION_ENV.OIDC_ISSUER,
      OIDC_CLIENT_ID: COMPLETE_PRODUCTION_ENV.OIDC_CLIENT_ID,
      OIDC_CLIENT_SECRET: COMPLETE_PRODUCTION_ENV.OIDC_CLIENT_SECRET,
      WEB_ORIGIN: COMPLETE_PRODUCTION_ENV.WEB_ORIGIN,
      PUBLIC_WEBHOOK_URL: COMPLETE_PRODUCTION_ENV.PUBLIC_WEBHOOK_URL,
      GOOGLE_CLIENT_ID: COMPLETE_PRODUCTION_ENV.GOOGLE_CLIENT_ID,
    } as NodeJS.ProcessEnv;
    expect(() => assertRealModeConfig(loadConfig(env), env)).toThrow(/GOOGLE_CLIENT_SECRET/);
  });
});
