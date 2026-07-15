/**
 * Telephony adapter barrel (apps/api, task 3a). The composition root
 * (`../registry.ts`) binds `createMockTelephonyProvider` under `MOCK_MODE=1`;
 * everything above the adapter line imports only the `TelephonyProvider` interface
 * from `@switchboard/shared/providers`. See `./README.md` for exact registry wiring.
 */

export { MockTelephonyProvider, createMockTelephonyProvider } from './mock-telephony-provider.ts';
export type {
  MockTelephonyProviderOptions,
  EmittedTelephonyWebhook,
  TelephonyWebhookHandler,
  SmsSendInterceptor,
} from './mock-telephony-provider.ts';

export {
  MOCK_TWILIO_AUTH_TOKEN,
  TWILIO_SIGNATURE_HEADER,
  parseFormBody,
  readHeader,
  signTwilioForm,
  twilioSignatureBaseString,
  verifyTwilioSignature,
} from './twilio-signature.ts';

export {
  DEFAULT_PUBLIC_WEBHOOK_BASE,
  MOCK_ACCOUNT_SID,
  TWILIO_API_VERSION,
  buildSignedWire,
  callEventToParams,
  defaultCallbackUrls,
  defaultOutboundSteps,
  encodeForm,
  inboundSmsToParams,
  inboundVoicemailSteps,
  recordingUrl,
  toFixtureEnvelope,
} from './twilio-wire.ts';
export type {
  CallWireContext,
  LifecycleStep,
  TwilioCallbackUrls,
  TwilioFixtureEnvelope,
  TwilioWirePayload,
} from './twilio-wire.ts';

export { OPT_OUT_KEYWORDS, matchOptOutKeyword } from './opt-out.ts';
export type { OptOutKeyword } from './opt-out.ts';
