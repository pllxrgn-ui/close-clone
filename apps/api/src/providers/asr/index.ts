/**
 * ASR adapter barrel (apps/api, task 3e). The composition root (`../registry.ts`)
 * binds `createMockASRProvider` under `MOCK_MODE=1` and `createDeepgramASRProvider`
 * in real mode; everything above the adapter line imports only the `ASRProvider`
 * interface from `@switchboard/shared/providers`. Wiring lives in the route/registry
 * merge step (see the task report `routeWiring`), never in this file.
 */

export { MockASRProvider, createMockASRProvider } from './mock-asr-provider.ts';
export type { MockASRProviderOptions } from './mock-asr-provider.ts';

export {
  DeepgramASRProvider,
  DeepgramApiError,
  FetchDeepgramTransport,
  createDeepgramASRProvider,
} from './deepgram-asr-provider.ts';
export type {
  DeepgramASRConfig,
  DeepgramTransport,
  DeepgramTransportRequest,
  DeepgramTransportResponse,
} from './deepgram-asr-provider.ts';
