/**
 * SMS service barrel (task 3f). The outbound send engine (the ONLY path to
 * `TelephonyProvider.sendSms`) plus the I-QUIET quiet-hours + area-code timezone
 * inference and first-contact opt-out language it enforces.
 *
 * Inbound STOP-family opt-out (suppress the number globally, emit `sms_opt_out`,
 * confirm once) is owned by the 3b telephony ingress worker
 * (`services/telephony/process.ts`, persist-then-process) — the send engine here
 * enforces the resulting global phone suppression at send time (I-DNC), so the two
 * halves of I-QUIET meet through the shared `suppressions(kind='phone')` rail.
 */

export {
  sendSms,
  SmsSendError,
  SmsValidationError,
  SmsLeadNotFoundError,
  SmsContactNotFoundError,
  SmsSuppressedError,
  SmsQuietHoursError,
  SmsProviderError,
  type SmsSendDeps,
  type SmsSendInput,
  type SmsSendResult,
} from './send.ts';

export {
  parseQuietHours,
  resolveQuietHoursTimezone,
  isWithinAllowedHours,
  quietHoursSchema,
  QUIET_HOURS_DEFAULT_START_MIN,
  QUIET_HOURS_DEFAULT_END_MIN,
  type QuietHoursConfig,
  type QuietHoursWindow,
} from './quiet-hours.ts';

export { inferTimezoneFromNumber } from './area-code-timezone.ts';

export {
  appendOptOutLanguage,
  bodyHasOptOutLanguage,
  DEFAULT_OPT_OUT_LANGUAGE,
} from './opt-out-language.ts';
