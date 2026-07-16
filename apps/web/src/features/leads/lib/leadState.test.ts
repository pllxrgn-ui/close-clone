import { describe, expect, test } from 'vitest';
import type { LeadStateInput } from './leadState.ts';
import {
  LEAD_STATE,
  LEAD_STATE_KEYS,
  deriveLeadStates,
  isNewReply,
  isOverdue,
  primaryLeadState,
} from './leadState.ts';

const NOW = new Date('2026-07-15T17:00:00.000Z');
const ago = (h: number): string => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const ahead = (h: number): string => new Date(NOW.getTime() + h * 3_600_000).toISOString();

function lead(over: Partial<LeadStateInput>): LeadStateInput {
  return {
    dnc: false,
    lastInboundAt: null,
    lastContactedAt: null,
    nextTaskDueAt: null,
    ...over,
  };
}

describe('isNewReply', () => {
  test('inbound with no prior outbound is a new reply', () => {
    expect(isNewReply(lead({ lastInboundAt: ago(2) }))).toBe(true);
  });
  test('inbound newer than last contact is a new reply', () => {
    expect(isNewReply(lead({ lastInboundAt: ago(1), lastContactedAt: ago(5) }))).toBe(true);
  });
  test('inbound older than last contact is NOT a new reply', () => {
    expect(isNewReply(lead({ lastInboundAt: ago(5), lastContactedAt: ago(1) }))).toBe(false);
  });
  test('no inbound at all is never a new reply', () => {
    expect(isNewReply(lead({ lastContactedAt: ago(1) }))).toBe(false);
  });
});

describe('isOverdue', () => {
  test('a past-due task is overdue', () => {
    expect(isOverdue(lead({ nextTaskDueAt: ago(3) }), NOW)).toBe(true);
  });
  test('a future task is not overdue', () => {
    expect(isOverdue(lead({ nextTaskDueAt: ahead(3) }), NOW)).toBe(false);
  });
  test('no task is not overdue', () => {
    expect(isOverdue(lead({}), NOW)).toBe(false);
  });
  test('failure path: an unparseable due date is treated as not-overdue', () => {
    expect(isOverdue(lead({ nextTaskDueAt: 'garbage' }), NOW)).toBe(false);
  });
});

describe('deriveLeadStates precedence', () => {
  test('a calm lead has no states', () => {
    expect(deriveLeadStates(lead({}), NOW)).toEqual([]);
    expect(primaryLeadState(lead({}), NOW)).toBeNull();
  });

  test('DNC dominates the rail even when other signals are present', () => {
    const states = deriveLeadStates(
      lead({ dnc: true, lastInboundAt: ago(1), nextTaskDueAt: ago(2) }),
      NOW,
    );
    expect(states[0]).toBe('dnc');
    expect(states).toEqual(['dnc', 'newReply', 'overdue']);
    expect(primaryLeadState(lead({ dnc: true, lastInboundAt: ago(1) }), NOW)).toBe('dnc');
  });

  test('new reply outranks overdue when not DNC', () => {
    const states = deriveLeadStates(lead({ lastInboundAt: ago(1), nextTaskDueAt: ago(2) }), NOW);
    expect(states).toEqual(['newReply', 'overdue']);
  });

  test('inSequence is not derivable from a bare Lead (documented gap)', () => {
    // No combination of Lead fields can produce inSequence today.
    const states = deriveLeadStates(
      lead({ dnc: true, lastInboundAt: ago(1), nextTaskDueAt: ago(1) }),
      NOW,
    );
    expect(states).not.toContain('inSequence');
  });
});

describe('LEAD_STATE metadata', () => {
  test('every state key has complete metadata', () => {
    for (const key of LEAD_STATE_KEYS) {
      const meta = LEAD_STATE[key];
      expect(meta.key).toBe(key);
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.solidVar.startsWith('--state-')).toBe(true);
    }
  });
  test('only the reply state is a glowing lamp', () => {
    expect(LEAD_STATE.newReply.lamp).toBe(true);
    expect(LEAD_STATE.overdue.lamp).toBe(false);
    expect(LEAD_STATE.inSequence.lamp).toBe(false);
    expect(LEAD_STATE.dnc.lamp).toBe(false);
  });
});
