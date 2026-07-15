import { describe, expect, test } from 'vitest';
import { createProviderRegistry } from './registry.ts';
import { MockEmailProvider } from './mock/mock-email-provider.ts';
import { GmailEmailProvider } from './email/gmail-email-provider.ts';
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

  test('non-mock mode without gmail config fails fast with a config error', () => {
    expect(() => createProviderRegistry({ mockMode: false })).toThrow(/gmail/i);
  });

  test('non-mock mode binds the real GmailEmailProvider when configured', () => {
    const registry = createProviderRegistry({
      mockMode: false,
      gmail: { clientId: 'cid', clientSecret: 'secret', address: 'rep@company.test' },
    });
    expect(registry.email).toBeInstanceOf(GmailEmailProvider);
  });
});
