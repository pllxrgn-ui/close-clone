import { describe, expect, test } from 'vitest';
import {
  ACTIVITY_TYPES,
  activityPayloadSchemas,
  parseActivityPayload,
  sequencePausedReasonValues,
} from './events.ts';

describe('activity payload schemas (CONTRACTS §C4)', () => {
  test('every taxonomy type has a payload schema', () => {
    for (const type of ACTIVITY_TYPES) {
      expect(activityPayloadSchemas[type]).toBeDefined();
    }
  });

  test('field_changed requires {field, before, after}', () => {
    expect(() => parseActivityPayload('field_changed', { before: 1, after: 2 })).toThrow();
    const ok = parseActivityPayload('field_changed', { field: 'status', before: 'a', after: 'b' });
    expect(ok.field).toBe('status');
  });

  test('sequence_paused requires a reason from the fixed set', () => {
    for (const reason of sequencePausedReasonValues) {
      expect(parseActivityPayload('sequence_paused', { reason }).reason).toBe(reason);
    }
    expect(() => parseActivityPayload('sequence_paused', { reason: 'nope' })).toThrow();
    expect(() => parseActivityPayload('sequence_paused', {})).toThrow();
  });

  test('open payloads keep unknown provider metadata (passthrough)', () => {
    const parsed = parseActivityPayload('email_sent', { subject: 'Hi', gmailLabel: 'INBOX' });
    expect(parsed).toMatchObject({ subject: 'Hi', gmailLabel: 'INBOX' });
  });

  test('permissive-but-typed: bad field type is rejected', () => {
    expect(() => parseActivityPayload('opportunity_created', { valueCents: 'lots' })).toThrow();
  });
});
