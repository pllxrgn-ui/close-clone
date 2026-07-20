import { z } from 'zod';

/**
 * Typed, zod-validated runtime config (CONTRACTS §C9: every module works under
 * MOCK_MODE=1 with no external accounts). Parse once at boot; never read
 * `process.env` elsewhere.
 */

const boolFlag = z.enum(['0', '1']).transform((v) => v === '1');

/**
 * The dev/test fallback session secret. It is intentionally weak and is REJECTED
 * in production (see {@link loadConfig}) — it keys the session-cookie HMAC, the
 * AES OAuth-token cipher, and the unsubscribe HMAC, so a default/unset value in
 * production would allow cookie forgery and token decryption.
 */
const DEV_SESSION_SECRET = 'dev-insecure-session-secret';

/**
 * Publicly-known placeholder secrets that MUST be rejected in production even
 * though they satisfy the length floor — they ship in `.env.example`, git, and
 * docs, so treating them as valid would hand every reader a working key. Keep in
 * sync with `.env.example`.
 */
const KNOWN_INSECURE_SECRETS: ReadonlySet<string> = new Set([
  DEV_SESSION_SECRET,
  'change-me-to-a-64-char-random-hex-string',
  'change-me-32-chars-minimum-000000',
]);

/** Minimum acceptable SESSION_SECRET length in production. */
const MIN_PROD_SESSION_SECRET_LEN = 32;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  MOCK_MODE: boolFlag.default('1'),
  DATABASE_URL: z.string().min(1).default('postgres://localhost:5432/switchboard'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  SESSION_SECRET: z.string().min(1).default(DEV_SESSION_SECRET),
});

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  mockMode: boolean;
  databaseUrl: string;
  redisUrl: string;
  sessionSecret: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse({
    NODE_ENV: env.NODE_ENV,
    PORT: env.PORT,
    MOCK_MODE: env.MOCK_MODE,
    DATABASE_URL: env.DATABASE_URL,
    REDIS_URL: env.REDIS_URL,
    SESSION_SECRET: env.SESSION_SECRET,
  });
  // Fail closed in production: an unset (→ dev default), publicly-known
  // placeholder, or too-short SESSION_SECRET would let an attacker forge session
  // cookies and decrypt stored OAuth tokens. Dev/test keep the weak default so
  // MOCK_MODE runs with no config.
  if (
    parsed.NODE_ENV === 'production' &&
    (KNOWN_INSECURE_SECRETS.has(parsed.SESSION_SECRET) ||
      parsed.SESSION_SECRET.length < MIN_PROD_SESSION_SECRET_LEN)
  ) {
    throw new Error(
      'SESSION_SECRET must be set to a strong unique value in production (>=32 chars); the dev default and .env.example placeholder are insecure.',
    );
  }
  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    mockMode: parsed.MOCK_MODE,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    sessionSecret: parsed.SESSION_SECRET,
  };
}
