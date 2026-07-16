import { describe, expect, test } from 'vitest';

import {
  WEBHOOK_EVENT_TYPES,
  WILDCARD_EVENT,
  assertValidEventSelectors,
  isWebhookEventType,
  parseSubscribedEvents,
  subscriptionMatches,
} from './events.ts';

/** Task 5c — outbound event taxonomy + subscription matching. */

describe('event taxonomy', () => {
  test('covers lead / opportunity / activity', () => {
    expect(WEBHOOK_EVENT_TYPES).toContain('lead.created');
    expect(WEBHOOK_EVENT_TYPES).toContain('opportunity.stage_changed');
    expect(WEBHOOK_EVENT_TYPES).toContain('activity.recorded');
  });

  test('isWebhookEventType guards unknowns', () => {
    expect(isWebhookEventType('lead.created')).toBe(true);
    expect(isWebhookEventType('lead.exploded')).toBe(false);
    expect(isWebhookEventType(3)).toBe(false);
  });
});

describe('parseSubscribedEvents', () => {
  test('extracts known types, drops junk, sets the all-flag on wildcard', () => {
    expect(parseSubscribedEvents(['lead.created', 'junk', 'lead.created'])).toEqual({
      all: false,
      types: ['lead.created'],
    });
    expect(parseSubscribedEvents([WILDCARD_EVENT, 'opportunity.closed'])).toEqual({
      all: true,
      types: ['opportunity.closed'],
    });
    expect(parseSubscribedEvents('nope')).toEqual({ all: false, types: [] });
  });
});

describe('subscriptionMatches', () => {
  test('exact type match', () => {
    expect(subscriptionMatches(['lead.created'], 'lead.created')).toBe(true);
    expect(subscriptionMatches(['lead.created'], 'lead.updated')).toBe(false);
  });

  test('wildcard receives everything', () => {
    for (const t of WEBHOOK_EVENT_TYPES) {
      expect(subscriptionMatches([WILDCARD_EVENT], t)).toBe(true);
    }
  });

  test('empty selector receives nothing', () => {
    expect(subscriptionMatches([], 'activity.recorded')).toBe(false);
  });
});

describe('assertValidEventSelectors', () => {
  test('accepts known types and the wildcard', () => {
    expect(() => assertValidEventSelectors(['lead.created', WILDCARD_EVENT])).not.toThrow();
  });

  test('rejects an unknown selector', () => {
    expect(() => assertValidEventSelectors(['lead.created', 'bogus'])).toThrow(/unknown webhook/);
  });
});
