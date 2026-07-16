import { describe, expect, test } from 'vitest';
import { render } from '@testing-library/react';
import { ACTIVITY_TYPES } from '@switchboard/shared';
import {
  EVENT_TONE_CLASS,
  FALLBACK_EVENT_META,
  isKnownEventType,
  resolveEventMeta,
} from './eventMeta.tsx';

describe('eventMeta — C4 coverage', () => {
  // The load-bearing acceptance: EVERY C4 activity type must resolve to a
  // dedicated meta, never the defensive fallback.
  test.each(ACTIVITY_TYPES)('“%s” resolves to a known, non-fallback meta', (type) => {
    expect(isKnownEventType(type)).toBe(true);
    const meta = resolveEventMeta(type);
    expect(meta).not.toBe(FALLBACK_EVENT_META);
    expect(typeof meta.icon).toBe('function');
    expect(meta.label.length).toBeGreaterThan(0);
    expect(Object.keys(EVENT_TONE_CLASS)).toContain(meta.tone);
  });

  test('every C4 icon renders an <svg> (no missing glyph)', () => {
    for (const type of ACTIVITY_TYPES) {
      const Icon = resolveEventMeta(type).icon;
      const { container, unmount } = render(<Icon />);
      expect(container.querySelector('svg')).not.toBeNull();
      unmount();
    }
  });

  test('coverage count matches the taxonomy (no dead/duplicate entries)', () => {
    const known = ACTIVITY_TYPES.filter(isKnownEventType);
    expect(known.length).toBe(ACTIVITY_TYPES.length);
  });
});

describe('eventMeta — fallback path', () => {
  test('an unknown type is not "known" and yields the fallback', () => {
    expect(isKnownEventType('totally_made_up')).toBe(false);
    expect(resolveEventMeta('totally_made_up')).toBe(FALLBACK_EVENT_META);
  });
});

describe('eventMeta — detail derivation', () => {
  test('email detail surfaces the subject', () => {
    const meta = resolveEventMeta('email_received');
    expect(meta.detail?.({ subject: 'Re: pricing' })).toBe('Re: pricing');
    expect(meta.detail?.({})).toBeNull();
  });

  test('field_changed names the field', () => {
    expect(resolveEventMeta('field_changed').detail?.({ field: 'owner' })).toBe('Changed owner');
  });

  test('status_changed shows a from→to transition', () => {
    expect(resolveEventMeta('status_changed').detail?.({ from: 'Potential', to: 'Qualified' })).toBe(
      'Potential → Qualified',
    );
  });

  test('sequence_paused surfaces the reason', () => {
    expect(resolveEventMeta('sequence_paused').detail?.({ reason: 'reply' })).toBe('Reason: reply');
  });

  test('opportunity_closed combines outcome and compact value', () => {
    expect(
      resolveEventMeta('opportunity_closed').detail?.({ status: 'won', valueCents: 1_250_000 }),
    ).toBe('won · $12.5K');
  });

  test('import_created counts rows; sms truncates long bodies', () => {
    expect(resolveEventMeta('import_created').detail?.({ rowCount: 1500 })).toBe('1,500 rows');
    const long = 'a'.repeat(120);
    const out = resolveEventMeta('sms_sent').detail?.({ body: long });
    expect(out?.endsWith('…')).toBe(true);
  });
});
