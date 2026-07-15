import type { EmailProvider } from '@switchboard/shared/providers';
import { MockEmailProvider } from './mock/mock-email-provider.ts';
import { GmailEmailProvider } from './email/gmail-email-provider.ts';
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
  email: EmailProvider;
}

export interface RegistryConfig {
  mockMode: boolean;
  /** Required for the real (non-mock) branch; ignored under `mockMode`. */
  gmail?: GmailBindingConfig;
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
    return { email: new MockEmailProvider(mockOverrides) };
  }
  if (config.gmail === undefined) {
    throw new Error(
      'real email provider requires gmail OAuth config (clientId/clientSecret/address); ' +
        'set MOCK_MODE=1 to use the in-memory provider',
    );
  }
  return {
    email: new GmailEmailProvider({
      clientId: config.gmail.clientId,
      clientSecret: config.gmail.clientSecret,
      address: config.gmail.address,
      ...(config.gmail.scopes !== undefined ? { scopes: config.gmail.scopes } : {}),
    }),
  };
}
