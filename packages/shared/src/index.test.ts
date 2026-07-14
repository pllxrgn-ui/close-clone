import { describe, expect, it } from 'vitest';
import { VERSION, ACTIVITY_TYPES, activityTypeSchema, DSL_GRAMMAR_VERSION } from './index.ts';

describe('@switchboard/shared', () => {
  it('exports a semver VERSION', () => {
    expect(VERSION).toBe('0.0.0');
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('exposes the full C4 activity taxonomy', () => {
    expect(ACTIVITY_TYPES).toContain('call_logged');
    expect(ACTIVITY_TYPES).toContain('sequence_paused');
    // C4 lists 31 event types.
    expect(ACTIVITY_TYPES).toHaveLength(31);
  });

  it('validates activity types via the zod enum', () => {
    expect(activityTypeSchema.parse('email_sent')).toBe('email_sent');
    expect(activityTypeSchema.safeParse('not_a_type').success).toBe(false);
  });

  it('exposes the DSL grammar version', () => {
    expect(DSL_GRAMMAR_VERSION).toBe('1.0.0');
  });
});
