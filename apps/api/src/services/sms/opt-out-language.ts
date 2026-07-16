import { OPT_OUT_KEYWORDS } from '../../providers/telephony/opt-out.ts';

/**
 * First-contact opt-out language (§4.5, CONTRACTS §C6 I-QUIET). Every first
 * outbound SMS to a number must carry an unsubscribe instruction so the recipient
 * always has a documented STOP path before a second message. The exact STOP-family
 * keyword set is the single source of truth in `providers/telephony/opt-out.ts`
 * (the same set the inbound ingress classifies), so the sent language and the
 * accepted reply never drift apart.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

/** Default first-contact opt-out sentence appended to the body. */
export const DEFAULT_OPT_OUT_LANGUAGE = 'Reply STOP to unsubscribe.';

/**
 * True iff the body already contains a STOP-family keyword as a standalone word
 * (case-insensitive) — in which case the sender has written their own opt-out
 * instruction and we must not append a duplicate. Word-boundary matched so a
 * substring like "nonstop" does not count.
 */
export function bodyHasOptOutLanguage(body: string): boolean {
  const upper = body.toUpperCase();
  return OPT_OUT_KEYWORDS.some((kw) => new RegExp(`\\b${kw}\\b`).test(upper));
}

/**
 * Append the opt-out sentence to `body` with a single separating space, unless the
 * body already ends with one. Never double-appends (callers gate on
 * {@link bodyHasOptOutLanguage}); this is the pure string join.
 */
export function appendOptOutLanguage(body: string, language?: string): string {
  const suffix = language ?? DEFAULT_OPT_OUT_LANGUAGE;
  const trimmed = body.replace(/\s+$/, '');
  if (trimmed.length === 0) return suffix;
  return `${trimmed} ${suffix}`;
}
