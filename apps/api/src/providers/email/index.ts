/**
 * Gmail email adapter (task 2b). The composition root (`providers/registry.ts`)
 * selects this vs `MockEmailProvider`; everything above the adapter line consumes
 * only the `EmailProvider` interface from `@switchboard/shared/providers`.
 */

export {
  GmailEmailProvider,
  GmailApiError,
  coalesceHistory,
  flattenHeaders,
  extractBodies,
  buildMime,
  type GmailProviderConfig,
} from './gmail-email-provider.ts';
export {
  fetchTransport,
  type GmailTransport,
  type GmailHttpRequest,
  type GmailHttpResponse,
} from './gmail-transport.ts';
