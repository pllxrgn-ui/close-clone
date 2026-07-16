/**
 * Telephony service barrel (task 3b). The ingress (persist-then-process), the
 * lifecycle→timeline worker, inbound routing, the dial/patch engine, and the phone
 * helpers. Everything above the adapter line consumes the C2 `TelephonyProvider`
 * interface; the composition root binds the mock (3a) or the real Twilio adapter.
 */

export {
  parseTwilioWebhook,
  persistTwilioWebhook,
  SignatureTwilioVerifier,
  InvalidTwilioWebhookError,
  type TwilioChannel,
  type TwilioIngressVerifier,
  type ParsedTwilioWebhook,
  type PersistTwilioResult,
} from './ingress.ts';

export {
  processTwilioInboxRow,
  processPendingTwilioWebhooks,
  classifyTerminal,
  TERMINAL_CALL_ACTIVITIES,
  type TelephonyProcessDeps,
  type ProcessResult,
} from './process.ts';

export {
  resolveInboundRouting,
  renderVoiceTwiml,
  ActiveUsersRingGroup,
  type RingGroupResolver,
  type RoutingPlan,
  type RoutingTier,
  type InboundRoutingDeps,
  type VoiceTwimlOptions,
} from './routing.ts';

export {
  dialCall,
  patchCall,
  DialValidationError,
  DialLeadNotFoundError,
  DialContactNotFoundError,
  DialBlockedError,
  DialProviderError,
  CallNotFoundError,
  type DialDeps,
  type DialInput,
  type DialOutcome,
  type PatchCallDeps,
  type PatchCallInput,
  type PatchCallResult,
} from './dial.ts';

export { resolveContactByPhone, phoneMatchKey, type ContactMatch } from './phone.ts';
export {
  isPhoneSuppressed,
  addPhoneSuppression,
  type PhoneSuppressionSource,
  type AddPhoneSuppressionInput,
  type AddPhoneSuppressionResult,
} from './suppression.ts';

export {
  TWILIO_PROCESS_JOB,
  twilioProcessJobId,
  enqueueTwilioProcess,
  handleTelephonyJob,
} from './worker.ts';
