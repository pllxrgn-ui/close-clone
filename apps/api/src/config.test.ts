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
