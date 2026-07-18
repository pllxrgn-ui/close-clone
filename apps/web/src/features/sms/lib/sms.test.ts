import { describe, expect, it } from 'vitest';
import type { SmsMessage } from '@switchboard/shared';
import {
  DEFAULT_OPT_OUT_LANGUAGE,
  appendOptOutLanguage,
  areaCodeOf,
  bodyHasOptOutText,
  dayKey,
  dayLabel,
  detectEncoding,
  formatPhone,
  groupMessagesByDay,
  hasPriorOutbound,
  hourInTimeZone,
  isInboundOptOut,
  isWithinQuietWindow,
  phoneMatchKey,
  quietWindowState,
  smsSegments,
  threadIsOptedOut,
  timeZoneForNumber,
} from './sms.ts';

const TS = '2026-07-15T17:00:00.000Z';

function msg(over: Partial<SmsMessage>): SmsMessage {
  return {
    id: over.id ?? 'm1',
    leadId: 'L1',
    contactId: null,
    userId: null,
    direction: 'outbound',
    fromNumber: '+12065550100',
    toNumber: '+12065551234',
    body: 'hi',
    providerSid: 'SM1',
    status: 'sent',
    sentAt: TS,
    createdAt: TS,
    updatedAt: TS,
    ...over,
  };
}

describe('opt-out classification', () => {
  it('treats a whole-body STOP-family keyword as an inbound opt-out (case-insensitive)', () => {
    for (const kw of ['STOP', 'stop', ' Quit ', 'unsubscribe', 'CANCEL', 'end']) {
      expect(isInboundOptOut(kw)).toBe(true);
    }
  });

  it('does NOT treat a sentence merely containing "stop" as an inbound opt-out', () => {
    expect(isInboundOptOut('please stop texting me')).toBe(false);
    expect(isInboundOptOut('')).toBe(false);
    expect(isInboundOptOut('stopper')).toBe(false);
  });

  it('detects standalone opt-out words in an outbound body (append gate)', () => {
    expect(bodyHasOptOutText('Thanks! Reply STOP to unsubscribe.')).toBe(true);
    expect(bodyHasOptOutText('text STOP anytime')).toBe(true);
    expect(bodyHasOptOutText('nonstop deals all week')).toBe(false);
    expect(bodyHasOptOutText('just a normal message')).toBe(false);
  });

  it('appends opt-out language with exactly one separating space', () => {
    expect(appendOptOutLanguage('Hello there')).toBe(`Hello there ${DEFAULT_OPT_OUT_LANGUAGE}`);
    expect(appendOptOutLanguage('Hello there   ')).toBe(`Hello there ${DEFAULT_OPT_OUT_LANGUAGE}`);
    expect(appendOptOutLanguage('')).toBe(DEFAULT_OPT_OUT_LANGUAGE);
    expect(appendOptOutLanguage('Hi', 'Txt STOP to opt out.')).toBe('Hi Txt STOP to opt out.');
  });
});

describe('segment / character counting', () => {
  it('counts a plain ASCII body as GSM-7, single segment', () => {
    const info = smsSegments('Hello');
    expect(info.encoding).toBe('gsm7');
    expect(info.units).toBe(5);
    expect(info.segments).toBe(1);
    expect(info.perSegment).toBe(160);
    expect(info.remaining).toBe(155);
  });

  it('reports zero segments for an empty body', () => {
    expect(smsSegments('').segments).toBe(0);
  });

  it('splits a 161-char GSM-7 body into 2 segments at 153/segment', () => {
    const info = smsSegments('a'.repeat(161));
    expect(info.segments).toBe(2);
    expect(info.perSegment).toBe(153);
    expect(info.usedInSegment).toBe(161 - 153);
  });

  it('counts GSM-7 extension characters as two septets', () => {
    // '€' is a GSM-7 extension char → 2 septets, still gsm7.
    const info = smsSegments('€');
    expect(info.encoding).toBe('gsm7');
    expect(info.units).toBe(2);
  });

  it('switches to UCS-2 (70/67) when a non-GSM character appears', () => {
    expect(detectEncoding('café ☕')).toBe('ucs2');
    const info = smsSegments('☕'.repeat(71));
    expect(info.encoding).toBe('ucs2');
    expect(info.perSegment).toBe(67);
    expect(info.segments).toBe(2);
  });
});

describe('phone formatting', () => {
  it('formats NANP numbers and strips the country code', () => {
    expect(formatPhone('+12065551234')).toBe('(206) 555-1234');
    expect(formatPhone('2065551234')).toBe('(206) 555-1234');
  });

  it('returns unrecognised input unchanged', () => {
    expect(formatPhone('12')).toBe('12');
    expect(formatPhone('not-a-number')).toBe('not-a-number');
  });

  it('matches numbers by their last 10 digits across formats', () => {
    expect(phoneMatchKey('+1 (206) 555-1234')).toBe('2065551234');
    expect(phoneMatchKey('2065551234')).toBe('2065551234');
  });
});

describe('quiet hours (I-QUIET)', () => {
  it('infers a recipient timezone from the area code, else falls back', () => {
    expect(timeZoneForNumber('+12065551234', 'America/New_York').timeZone).toBe(
      'America/Los_Angeles',
    );
    expect(areaCodeOf('+12065551234')).toBe('206');
    // Unknown area code → fallback company tz.
    expect(timeZoneForNumber('+19995551234', 'America/Chicago').timeZone).toBe('America/Chicago');
    expect(areaCodeOf('short')).toBeNull();
  });

  it('computes the local hour in a timezone', () => {
    // 17:00Z in July → 10:00 PDT (UTC-7).
    expect(hourInTimeZone(new Date('2026-07-15T17:00:00Z'), 'America/Los_Angeles')).toBe(10);
  });

  it('is within the window at 10am local and outside at 11pm / 6am local', () => {
    const tz = 'America/Los_Angeles';
    expect(isWithinQuietWindow(new Date('2026-07-15T17:00:00Z'), tz)).toBe(true); // 10am
    expect(isWithinQuietWindow(new Date('2026-07-15T06:00:00Z'), tz)).toBe(false); // 11pm prev day
    expect(isWithinQuietWindow(new Date('2026-07-15T13:00:00Z'), tz)).toBe(false); // 6am
  });

  it('surfaces the resolved timezone + area code alongside the within flag', () => {
    const state = quietWindowState(
      new Date('2026-07-15T06:00:00Z'),
      '+12065551234',
      'America/New_York',
    );
    expect(state).toEqual({ within: false, timeZone: 'America/Los_Angeles', areaCode: '206' });
  });
});

describe('thread-derived facts', () => {
  it('flags a thread as opted out when it contains an inbound STOP', () => {
    expect(threadIsOptedOut([msg({ direction: 'outbound', body: 'hi' })])).toBe(false);
    expect(
      threadIsOptedOut([
        msg({ direction: 'outbound', body: 'hi' }),
        msg({ id: 'm2', direction: 'inbound', body: 'STOP' }),
      ]),
    ).toBe(true);
    // A normal inbound reply does not opt out.
    expect(threadIsOptedOut([msg({ id: 'm3', direction: 'inbound', body: 'sounds good' })])).toBe(
      false,
    );
  });

  it('detects a prior outbound to the same number (first-contact gate)', () => {
    const thread = [msg({ direction: 'outbound', toNumber: '+1 (206) 555-1234' })];
    expect(hasPriorOutbound(thread, '2065551234')).toBe(true);
    expect(hasPriorOutbound(thread, '+13125559999')).toBe(false);
    expect(
      hasPriorOutbound([msg({ direction: 'inbound', toNumber: '+12065550100' })], '2065550100'),
    ).toBe(false);
  });
});

describe('thread display grouping', () => {
  // Construct instants via the LOCAL Date constructor (noon) so the viewer-local
  // day math is timezone-independent — no midnight-crossing regardless of the runner.
  const local = (y: number, m: number, d: number): string =>
    new Date(y, m, d, 12, 0, 0).toISOString();
  const NOW = new Date(2026, 6, 15, 20, 0, 0);

  it('labels today and yesterday relative to now', () => {
    expect(dayLabel(local(2026, 6, 15), NOW)).toBe('Today');
    expect(dayLabel(local(2026, 6, 14), NOW)).toBe('Yesterday');
    expect(dayLabel(local(2026, 6, 10), NOW)).not.toMatch(/Today|Yesterday/);
  });

  it('groups a chronological thread into contiguous day runs', () => {
    const groups = groupMessagesByDay(
      [
        msg({ id: 'a', sentAt: local(2026, 6, 14) }),
        msg({ id: 'b', sentAt: new Date(2026, 6, 14, 13, 0, 0).toISOString() }),
        msg({ id: 'c', sentAt: local(2026, 6, 15) }),
      ],
      NOW,
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]?.messages.map((m) => m.id)).toEqual(['a', 'b']);
    expect(groups[1]?.messages.map((m) => m.id)).toEqual(['c']);
    expect(groups[1]?.label).toBe('Today');
  });

  it('produces a stable Y-M-D day key', () => {
    expect(dayKey('2026-07-05T12:00:00.000Z')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
