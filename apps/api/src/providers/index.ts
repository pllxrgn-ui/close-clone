/**
 * Provider adapters barrel (apps/api). The composition root (`registry.ts`) is
 * the only place that selects mock vs real; everything above imports the
 * `EmailProvider` interface from `@switchboard/shared/providers`.
 */

export { createProviderRegistry } from './registry.ts';
export type { ProviderRegistry, RegistryConfig, MockRegistryOverrides } from './registry.ts';
export { MockEmailProvider } from './mock/mock-email-provider.ts';
export type { MockEmailProviderOptions, SendInterceptor } from './mock/mock-email-provider.ts';
export { ManualClock, SequentialIds } from './mock/clock.ts';
export type { Clock, IdSource } from './mock/clock.ts';
