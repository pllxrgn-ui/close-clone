import type { SmsMessage } from '@switchboard/shared';

/*
 * Pure SMS helpers for the two-way SMS surface (task U2). No React, no I/O — every
 * function is deterministic so the composer's character/segment counter, the
 * first-contact opt-out gate, and the I-QUIET quiet-hours note are unit-testable in
 * isolation and identical in the demo (MSW) and real-API modes.
 *
 * The STOP-family keyword set and the two matching rules MIRROR the server's single
 * sources of truth so the UI never disagrees with the engine that actually enforces
 * them (apps/api/src/providers/telephony/opt-out.ts +
 * apps/api/src/services/sms/opt-out-language.ts):
 *   - inbound classification: the WHOLE trimmed, upper-cased body equals a keyword
 *     (Twilio default — "please stop" is not an opt-out);
 *   - outbound append gate: a keyword appears as a standalone word (so we never
 *     double-append opt-out language to a body that already carries it).
 */

// ── STOP-family opt-out (mirrors the server keyword set) ─────────────────────

/** §C6 I-QUIET STOP-family keywords (mirror of the server's OPT_OUT_KEYWORDS). */
export const OPT_OUT_KEYWORDS = ['STOP', 'UNSUBSCRIBE', 'QUIT', 'CANCEL', 'END'] as const;

/** Default first-contact opt-out sentence (mirror of the server's default). */
export const DEFAULT_OPT_OUT_LANGUAGE = 'Reply STOP to unsubscribe.';

/**
 * True iff `body` (as a whole, trimmed, case-insensitive) IS a STOP-family keyword
 * — the inbound opt-out classification. Used to detect an opted-out number from the
 * conversation thread itself, so no separate suppression read is required.
 */
export function isInboundOptOut(body: string): boolean {
  const normalized = body.trim().toUpperCase();
  return (OPT_OUT_KEYWORDS as readonly string[]).includes(normalized);
}

/**
 * True iff `body` already contains a STOP-family keyword as a standalone word
 * (case-insensitive, word-boundary matched so "nonstop" does not count) — the gate
 * that stops us appending duplicate first-contact opt-out language.
 */
export function bodyHasOptOutText(body: string): boolean {
  const upper = body.toUpperCase();
  return OPT_OUT_KEYWORDS.some((kw) => new RegExp(`\\b${kw}\\b`).test(upper));
}

/**
 * Append the opt-out sentence to `body` with a single separating space. Pure string
 * join (callers gate on {@link bodyHasOptOutText}); never double-spaces.
 */
export function appendOptOutLanguage(
  body: string,
  language: string = DEFAULT_OPT_OUT_LANGUAGE,
): string {
  const trimmed = body.replace(/\s+$/, '');
  return trimmed.length === 0 ? language : `${trimmed} ${language}`;
}

// ── Character / segment counting (GSM-7 vs UCS-2, 3GPP 23.038) ────────────────

/** Basic GSM-7 alphabet — each character costs one septet. */
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
/** GSM-7 extension characters — each costs TWO septets (escape + char). */
const GSM7_EXTENSION = '\f^{}\\[~]|€';

export type SmsEncoding = 'gsm7' | 'ucs2';

export interface SegmentInfo {
  encoding: SmsEncoding;
  /** Billable units: septets (gsm7) or UTF-16 code units (ucs2). */
  units: number;
  /** Number of concatenated SMS segments the body would be split into. */
  segments: number;
  /** Unit capacity of the CURRENT segment size (single vs concatenated). */
  perSegment: number;
  /** Units already used within the final segment. */
  usedInSegment: number;
  /** Units remaining before the next segment starts. */
  remaining: number;
}

/** Pick the encoding a body forces: UCS-2 as soon as one non-GSM-7 char appears. */
export function detectEncoding(body: string): SmsEncoding {
  for (const ch of body) {
    if (GSM7_BASIC.includes(ch) || GSM7_EXTENSION.includes(ch)) continue;
    return 'ucs2';
  }
  return 'gsm7';
}

function countUnits(body: string, encoding: SmsEncoding): number {
  if (encoding === 'ucs2') return body.length;
  let n = 0;
  for (const ch of body) n += GSM7_EXTENSION.includes(ch) ? 2 : 1;
  return n;
}

/**
 * Segment breakdown for a body — the data behind the composer's "N chars · 1 msg"
 * counter. Single-segment capacity is 160 (gsm7) / 70 (ucs2); once concatenation
 * kicks in each segment loses header space (153 / 67).
 */
export function smsSegments(body: string): SegmentInfo {
  const encoding = detectEncoding(body);
  const units = countUnits(body, encoding);
  const single = encoding === 'gsm7' ? 160 : 70;
  const multi = encoding === 'gsm7' ? 153 : 67;
  const segments = units === 0 ? 0 : units <= single ? 1 : Math.ceil(units / multi);
  const perSegment = segments <= 1 ? single : multi;
  const usedInSegment = segments <= 1 ? units : units - (segments - 1) * multi;
  return {
    encoding,
    units,
    segments,
    perSegment,
    usedInSegment,
    remaining: perSegment - usedInSegment,
  };
}

// ── Phone formatting ─────────────────────────────────────────────────────────

/** The last 10 digits — the match key used to compare numbers across formats. */
export function phoneMatchKey(raw: string): string {
  return raw.replace(/\D/g, '').slice(-10);
}

/** Display a NANP number as `(206) 555-1234`; unrecognised input is returned as-is. */
export function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  const ten =
    digits.length === 11 && digits.startsWith('1')
      ? digits.slice(1)
      : digits.length === 10
        ? digits
        : null;
  if (ten === null) return raw;
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}

// ── I-QUIET quiet hours (8am–9pm recipient-local, area-code inferred) ─────────

/** Window opens at 08:00 recipient-local. */
export const QUIET_START_HOUR = 8;
/** Window closes at 21:00 (9pm) recipient-local. */
export const QUIET_END_HOUR = 21;

/**
 * A representative NANP area-code → IANA timezone map. This mirrors the SHAPE of
 * the server's richer `inferTimezoneFromNumber`; the UI only needs a plausible
 * recipient timezone for the advisory note (the engine re-checks authoritatively at
 * send). The demo fixtures issue `+1206…` numbers → Seattle (Pacific).
 */
const AREA_CODE_TZ: Record<string, string> = {
  '212': 'America/New_York',
  '646': 'America/New_York',
  '917': 'America/New_York',
  '202': 'America/New_York',
  '305': 'America/New_York',
  '404': 'America/New_York',
  '617': 'America/New_York',
  '312': 'America/Chicago',
  '773': 'America/Chicago',
  '512': 'America/Chicago',
  '214': 'America/Chicago',
  '303': 'America/Denver',
  '602': 'America/Phoenix',
  '206': 'America/Los_Angeles',
  '253': 'America/Los_Angeles',
  '415': 'America/Los_Angeles',
  '408': 'America/Los_Angeles',
  '310': 'America/Los_Angeles',
  '213': 'America/Los_Angeles',
  '503': 'America/Los_Angeles',
};

/** The 3-digit area code of a NANP number, or null if it has no 10-digit tail. */
export function areaCodeOf(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 10) return null;
  return digits.slice(-10).slice(0, 3);
}

/** Recipient timezone for a number, falling back to the org/company timezone. */
export function timeZoneForNumber(
  raw: string,
  fallbackTz: string,
): { areaCode: string | null; timeZone: string } {
  const areaCode = areaCodeOf(raw);
  const tz = areaCode !== null ? AREA_CODE_TZ[areaCode] : undefined;
  return { areaCode, timeZone: tz ?? fallbackTz };
}

/** The clock hour (0–23) at `now` in `timeZone`. */
export function hourInTimeZone(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hour12: false,
  }).formatToParts(now);
  const raw = parts.find((p) => p.type === 'hour')?.value ?? '0';
  const hour = Number(raw);
  return hour === 24 ? 0 : hour;
}

/** True iff `now` falls inside 8am–9pm in `timeZone` (I-QUIET). */
export function isWithinQuietWindow(now: Date, timeZone: string): boolean {
  const hour = hourInTimeZone(now, timeZone);
  return hour >= QUIET_START_HOUR && hour < QUIET_END_HOUR;
}

export interface QuietWindowState {
  within: boolean;
  timeZone: string;
  areaCode: string | null;
}

/** Everything the composer needs to render the I-QUIET note for a recipient number. */
export function quietWindowState(now: Date, number: string, fallbackTz: string): QuietWindowState {
  const { areaCode, timeZone } = timeZoneForNumber(number, fallbackTz);
  return { within: isWithinQuietWindow(now, timeZone), timeZone, areaCode };
}

// ── Thread-derived facts ─────────────────────────────────────────────────────

/** True iff `messages` contains an inbound STOP-family reply — the number is opted out. */
export function threadIsOptedOut(messages: readonly SmsMessage[]): boolean {
  return messages.some((m) => m.direction === 'inbound' && isInboundOptOut(m.body));
}

/**
 * True iff an outbound message to `toNumber` already exists in `messages` — the
 * first-contact gate for appending §4.5 opt-out language (mirrors the server's
 * `hasPriorOutboundSms`).
 */
export function hasPriorOutbound(messages: readonly SmsMessage[], toNumber: string): boolean {
  const key = phoneMatchKey(toNumber);
  return messages.some((m) => m.direction === 'outbound' && phoneMatchKey(m.toNumber) === key);
}

// ── Thread display formatting (viewer-local) ─────────────────────────────────

/** A bubble's clock time in the viewer's locale, e.g. "1:04 PM". */
export function formatClockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Viewer-local calendar-day key (Y-M-D) — the grouping key for day dividers. */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Day-divider label: Today / Yesterday, else a weekday + date. */
export function dayLabel(iso: string, now: Date): string {
  const key = dayKey(iso);
  if (key === dayKey(now.toISOString())) return 'Today';
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (key === dayKey(yesterday.toISOString())) return 'Yesterday';
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

export interface DayGroup {
  key: string;
  label: string;
  messages: SmsMessage[];
}

/**
 * Group an already-ordered (oldest → newest) message list into contiguous
 * calendar-day runs — the day dividers the thread renders between bubble runs.
 */
export function groupMessagesByDay(messages: readonly SmsMessage[], now: Date): DayGroup[] {
  const groups: DayGroup[] = [];
  let current: DayGroup | null = null;
  for (const message of messages) {
    const iso = message.sentAt ?? message.createdAt;
    const key = dayKey(iso);
    if (!current || current.key !== key) {
      current = { key, label: dayLabel(iso, now), messages: [] };
      groups.push(current);
    }
    current.messages.push(message);
  }
  return groups;
}
