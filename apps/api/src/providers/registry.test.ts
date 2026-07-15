import { describe, expect, test } from 'vitest';
import { createProviderRegistry } from './registry.ts';
import { MockEmailProvider } from './mock/mock-email-provider.ts';
import { ManualClock } from './mock/clock.ts';

describe('provider registry (composition root, CONTRACTS §C2)', () => {
  test('MOCK_MODE binds the in-memory MockEmailProvider', () => {
    const registry = createProviderRegistry({ mockMode: true });
    expect(registry.email).toBeInstanceOf(MockEmailProvider);
  });

  test('mock overrides (clock/address) reach the provider', () => {
    const registry = createProviderRegistry(
      { mockMode: true },
      { address: 'ceo@mock.test', clock: new ManualClock() },
    );
    expect(registry.email).toBeInstanceOf(MockEmailProvider);
    expect((registry.email as MockEmailProvider).address).toBe('ceo@mock.test');
  });

  test('non-mock mode fails fast until the real adapter lands (task 2b)', () => {
    expect(() => createProviderRegistry({ mockMode: false })).toThrow(/2b/);
  });
});
