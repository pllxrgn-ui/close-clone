/**
 * AI adapter barrel (apps/api, tasks 3e/3g). The composition root (`../registry.ts`)
 * binds `createMockAIProvider` under `MOCK_MODE=1` and `createHaikuAIProvider` in
 * real mode; everything above the adapter line imports only the `AIProvider`
 * interface from `@switchboard/shared/providers`. Wiring lives in the route/registry
 * merge step (see the task report `routeWiring`), never in this file.
 */

export { MockAIProvider, createMockAIProvider } from './mock-ai-provider.ts';
export type { MockAIProviderOptions } from './mock-ai-provider.ts';

export {
  HaikuAIProvider,
  AnthropicApiError,
  AIRefusalError,
  FetchAnthropicTransport,
  createHaikuAIProvider,
} from './haiku-ai-provider.ts';
export type {
  HaikuAIConfig,
  AnthropicTransport,
  AnthropicTransportRequest,
  AnthropicTransportResponse,
} from './haiku-ai-provider.ts';
