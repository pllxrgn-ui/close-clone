import type { EmailProvider } from '@switchboard/shared/providers';
import { MockEmailProvider } from './mock/mock-email-provider.ts';
import type { Clock, IdSource } from './mock/clock.ts';

/**
 * Provider composition root (ARCHITECTURE §1, CONTRACTS §C2).
 *
 * This is *the adapter line*: the one place that chooses mock vs real adapters
 * from `mockMode`. No code above this may branch on MOCK_MODE — callers depend
 * only on the `EmailProvider` interface, so every code path above is identical
 * whether the process is mocked or live.
 *
 * Real adapters (Gmail OAuth/history sync) land in task 2b; until then the live
 * branch fails fast rather than silently degrading.
 */

export interface ProviderRegistry {
  email: EmailProvider;
}

export interface RegistryConfig {
  mockMode: boolean;
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
  throw new Error(
    'real email provider adapter is not implemented yet (task 2b); run with MOCK_MODE=1',
  );
}
