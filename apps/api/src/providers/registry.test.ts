import { describe, expect, test } from 'vitest';
import { createProviderRegistry } from './registry.ts';
import { MockEmailProvider } from './mock/mock-email-provider.ts';
import { GmailEmailProvider } from './email/gmail-email-provider.ts';
import { TwilioTelephonyProvider } from './telephony/twilio-telephony-provider.ts';
import { DeepgramASRProvider } from './asr/deepgram-asr-provider.ts';
import { HaikuAIProvider } from './ai/haiku-ai-provider.ts';
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

  test('non-mock mode leaves account-gated providers disabled when unconfigured', () => {
    expect(createProviderRegistry({ mockMode: false })).toEqual({});
  });

  test('non-mock mode binds the real GmailEmailProvider when configured', () => {
    const registry = createProviderRegistry({
      mockMode: false,
      gmail: { clientId: 'cid', clientSecret: 'secret', address: 'rep@company.test' },
    });
    expect(registry.email).toBeInstanceOf(GmailEmailProvider);
  });

  test('non-mock mode binds every configured production provider', () => {
    const registry = createProviderRegistry({
      mockMode: false,
      twilio: { accountSid: 'AC123', authToken: 'secret' },
      deepgramApiKey: 'deepgram-key',
      anthropicApiKey: 'anthropic-key',
    });
    expect(registry.telephony).toBeInstanceOf(TwilioTelephonyProvider);
    expect(registry.asr).toBeInstanceOf(DeepgramASRProvider);
    expect(registry.ai).toBeInstanceOf(HaikuAIProvider);
  });
});
