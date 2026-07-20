import { expect, test } from 'vitest';
import { loadConfig } from './config.ts';

test('loadConfig applies MOCK_MODE-first defaults with an empty env', () => {
  const config = loadConfig({});
  expect(config.mockMode).toBe(true);
  expect(config.port).toBe(3000);
  expect(config.nodeEnv).toBe('development');
});

test('loadConfig parses provided env values', () => {
  const config = loadConfig({ MOCK_MODE: '0', PORT: '8080', NODE_ENV: 'test' });
  expect(config.mockMode).toBe(false);
  expect(config.port).toBe(8080);
  expect(config.nodeEnv).toBe('test');
});

const STRONG_SECRET = 'a'.repeat(48); // >= 32 chars, not the dev default

test('loadConfig fails closed in production when SESSION_SECRET is absent (dev default)', () => {
  expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/strong unique value in production/);
});

test('loadConfig fails closed in production when SESSION_SECRET is the dev default', () => {
  expect(() =>
    loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'dev-insecure-session-secret' }),
  ).toThrow(/insecure/);
});

test('loadConfig fails closed in production when SESSION_SECRET is the public .env.example placeholder', () => {
  // The placeholder is >=32 chars so it clears the length floor — it must still be
  // rejected because it ships in git/docs (KNOWN_INSECURE_SECRETS).
  expect(() =>
    loadConfig({
      NODE_ENV: 'production',
      MOCK_MODE: '0',
      SESSION_SECRET: 'change-me-to-a-64-char-random-hex-string',
    }),
  ).toThrow(/placeholder are insecure/);
});

test('loadConfig fails closed on the deploy template SESSION_SECRET', () => {
  expect(() =>
    loadConfig({
      NODE_ENV: 'production',
      SESSION_SECRET: 'change-me-32-chars-minimum-000000',
    }),
  ).toThrow(/placeholder are insecure/);
});

test('loadConfig fails closed in production when SESSION_SECRET is shorter than 32 chars', () => {
  expect(() =>
    loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'short-but-unique-secret' }),
  ).toThrow(/>=32 chars/);
});

test('loadConfig succeeds in production with a strong unique SESSION_SECRET', () => {
  const config = loadConfig({ NODE_ENV: 'production', SESSION_SECRET: STRONG_SECRET });
  expect(config.nodeEnv).toBe('production');
  expect(config.mockMode).toBe(true);
  expect(config.sessionSecret).toBe(STRONG_SECRET);
});

test('non-production keeps the dev default working (tests + dev stay green)', () => {
  expect(loadConfig({ NODE_ENV: 'test' }).sessionSecret).toBe('dev-insecure-session-secret');
  expect(loadConfig({}).sessionSecret).toBe('dev-insecure-session-secret');
});
