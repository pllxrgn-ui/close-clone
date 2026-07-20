import type {
  EmailProvider,
  TelephonyProvider,
  ASRProvider,
  AIProvider,
} from '@switchboard/shared/providers';
import { MockEmailProvider } from './mock/mock-email-provider.ts';
import { GmailEmailProvider } from './email/gmail-email-provider.ts';
import { createMockTelephonyProvider } from './telephony/index.ts';
import {
  createTwilioTelephonyProvider,
  FetchTwilioTransport,
  type TwilioTelephonyConfig,
} from './telephony/twilio-telephony-provider.ts';
import {
  createDeepgramASRProvider,
  createMockASRProvider,
  FetchDeepgramTransport,
} from './asr/index.ts';
import {
  createHaikuAIProvider,
  createMockAIProvider,
  FetchAnthropicTransport,
} from './ai/index.ts';
import type { Clock, IdSource } from './mock/clock.ts';

/**
 * Provider composition root (ARCHITECTURE §1, CONTRACTS §C2).
 *
 * This is *the adapter line*: the one place that chooses mock vs real adapters
 * from `mockMode`. No code above this may branch on MOCK_MODE — callers depend
 * only on the `EmailProvider` interface, so every code path above is identical
 * whether the process is mocked or live.
 *
 * The real branch binds the Gmail REST adapter (task 2b). It needs OAuth client
 * credentials plus a default mailbox identity, supplied by the caller from parsed
 * config (never `process.env` here — see `config.ts`). Absent that config the
 * branch fails fast with a configuration error rather than degrading silently.
 */

/**
 * Gmail OAuth binding for the real (non-mock) email provider. OAuth linking,
 * backfill, and history sync are mailbox-agnostic — each call is keyed by its
 * per-account OAuth tokens — so a single shared instance serves every mailbox.
 * Only `send()` needs a sender identity: `address` is the default From / the
 * Message-ID domain. Per-account send-from is task 2d's concern.
 */
export interface GmailBindingConfig {
  clientId: string;
  clientSecret: string;
  address: string;
  scopes?: string[];
}

export interface ProviderRegistry {
  email?: EmailProvider;
  /** All bound under mockMode; the real Twilio/Deepgram/Haiku adapters are wired
   *  at the deploy composition root (they need accounts — see deploy/WIRING.md). */
  telephony?: TelephonyProvider;
  asr?: ASRProvider;
  ai?: AIProvider;
}

export interface RegistryConfig {
  mockMode: boolean;
  /** Required for the real (non-mock) branch; ignored under `mockMode`. */
  gmail?: GmailBindingConfig;
  twilio?: Omit<TwilioTelephonyConfig, 'transport'>;
  deepgramApiKey?: string;
  anthropicApiKey?: string;
}

export interface MockRegistryOverrides {
  address?: string;
  clock?: Clock;
  ids?: IdSource;
}

export function createProviderRegistry(
  config: RegistryConfig,
  mockOverrides: MockRegistryOverrides = {},
): ProviderRegistry {
  if (config.mockMode) {
    return {
      email: new MockEmailProvider(mockOverrides),
      telephony: createMockTelephonyProvider({
        ...(mockOverrides.clock !== undefined ? { clock: mockOverrides.clock } : {}),
        ...(mockOverrides.ids !== undefined ? { ids: mockOverrides.ids } : {}),
      }),
      asr: createMockASRProvider(),
      ai: createMockAIProvider(),
    };
  }
  return {
    ...(config.gmail
      ? {
          email: new GmailEmailProvider({
            clientId: config.gmail.clientId,
            clientSecret: config.gmail.clientSecret,
            address: config.gmail.address,
            ...(config.gmail.scopes !== undefined ? { scopes: config.gmail.scopes } : {}),
          }),
        }
      : {}),
    ...(config.twilio
      ? {
          telephony: createTwilioTelephonyProvider({
            ...config.twilio,
            transport: new FetchTwilioTransport(),
          }),
        }
      : {}),
    ...(config.deepgramApiKey
      ? {
          asr: createDeepgramASRProvider({
            apiKey: config.deepgramApiKey,
            transport: new FetchDeepgramTransport(),
          }),
        }
      : {}),
    ...(config.anthropicApiKey
      ? {
          ai: createHaikuAIProvider({
            apiKey: config.anthropicApiKey,
            transport: new FetchAnthropicTransport(),
          }),
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Per-account send-from (task 2d)
// ---------------------------------------------------------------------------

/**
 * Per-account send-from (task 2d, resolving the 2b note). OAuth linking, backfill,
 * and history sync are mailbox-agnostic — one shared provider keyed by per-account
 * tokens serves them all. SEND is different: the From header and Message-ID domain
 * MUST be the *sending rep's own* mailbox address, not one shared configured
 * identity. This factory returns an `EmailProvider` bound to a specific mailbox
 * address, one cached instance per address (so the mock's idempotency ledger — and
 * any real per-mailbox state — persists across that mailbox's sends).
 *
 * The mock/real choice stays on THIS adapter line: it branches on `mockMode`,
 * never above (ARCHITECTURE §1). The account's own tokens are supplied separately
 * by the caller (decrypted from `email_accounts.oauth_tokens`).
 */
export type EmailProviderName = 'gmail' | 'mock';

export interface AccountIdentity {
  address: string;
  provider: EmailProviderName;
}

export interface EmailSenderRegistry {
  providerFor(identity: AccountIdentity): EmailProvider;
}

export function createEmailSenderRegistry(
  config: RegistryConfig,
  mockOverrides: MockRegistryOverrides = {},
): EmailSenderRegistry {
  const cache = new Map<string, EmailProvider>();
  return {
    providerFor(identity: AccountIdentity): EmailProvider {
      const key = `${identity.provider}:${identity.address.toLowerCase()}`;
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      const created = config.mockMode
        ? new MockEmailProvider({ ...mockOverrides, address: identity.address })
        : buildGmailForAddress(config, identity.address);
      cache.set(key, created);
      return created;
    },
  };
}

function buildGmailForAddress(config: RegistryConfig, address: string): EmailProvider {
  if (config.gmail === undefined) {
    throw new Error(
      'real email provider requires gmail OAuth config (clientId/clientSecret); ' +
        'set MOCK_MODE=1 to use the in-memory provider',
    );
  }
  return new GmailEmailProvider({
    clientId: config.gmail.clientId,
    clientSecret: config.gmail.clientSecret,
    address,
    ...(config.gmail.scopes !== undefined ? { scopes: config.gmail.scopes } : {}),
  });
}
