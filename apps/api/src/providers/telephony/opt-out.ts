/**
 * Inbound-SMS opt-out keywords (CONTRACTS §C6 I-QUIET). A message whose entire
 * body (trimmed, case-insensitive) equals one of these opts the sender out of SMS
 * globally. This is the single source of truth for the adapter, the mock fixtures,
 * and the engine's opt-out rail — so the keyword set is defined once, here.
 */
export const OPT_OUT_KEYWORDS = ['STOP', 'UNSUBSCRIBE', 'QUIT', 'CANCEL', 'END'] as const;
export type OptOutKeyword = (typeof OPT_OUT_KEYWORDS)[number];

/**
 * Classify an inbound SMS body as an opt-out. Returns the canonical keyword when
 * the trimmed, upper-cased body equals one of §I-QUIET's keywords, else null —
 * matching Twilio's default behaviour (the whole message must be the keyword, so a
 * sentence merely containing "stop" is not an opt-out).
 */
export function matchOptOutKeyword(body: string): OptOutKeyword | null {
  const normalized = body.trim().toUpperCase();
  return (OPT_OUT_KEYWORDS as readonly string[]).includes(normalized)
    ? (normalized as OptOutKeyword)
    : null;
}
