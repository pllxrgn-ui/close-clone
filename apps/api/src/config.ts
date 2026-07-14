import { z } from 'zod';

/**
 * Typed, zod-validated runtime config (CONTRACTS §C9: every module works under
 * MOCK_MODE=1 with no external accounts). Parse once at boot; never read
 * `process.env` elsewhere.
 */

const boolFlag = z.enum(['0', '1']).transform((v) => v === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  MOCK_MODE: boolFlag.default('1'),
  DATABASE_URL: z.string().min(1).default('postgres://localhost:5432/switchboard'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  SESSION_SECRET: z.string().min(1).default('dev-insecure-session-secret'),
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
  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    mockMode: parsed.MOCK_MODE,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    sessionSecret: parsed.SESSION_SECRET,
  };
}
