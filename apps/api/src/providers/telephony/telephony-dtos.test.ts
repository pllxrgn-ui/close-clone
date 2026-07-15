import { describe, expect, test } from 'vitest';
import {
  browserCallTokenSchema,
  callLifecycleEventSchema,
  callLifecycleTypeSchema,
  dialOptionsSchema,
  dialResultSchema,
  inboundSmsEventSchema,
  smsResultSchema,
  voicemailDropSchema,
  type CallLifecycleEvent,
} from '@switchboard/shared/providers';

/**
 * Schema-contract tests for the telephony DTOs appended to shared (task 3a,
 * milestone 1). These pin the runtime shapes the C2 `TelephonyProvider`
 * signatures reference — happy path and failure path per DTO.
 */

const ISO = '2026-07-15T12:00:00.000Z';

describe('browserCallTokenSchema', () => {
  test('accepts a well-formed token', () => {
    const token = { token: 'jwt.abc', identity: 'user-1', expiresAt: ISO, ttlSeconds: 3600 };
    expect(browserCallTokenSchema.parse(token)).toEqual(token);
  });

  test('rejects an empty token string', () => {
    expect(() =>
      browserCallTokenSchema.parse({ token: '', identity: 'u', expiresAt: ISO, ttlSeconds: 60 }),
    ).toThrow();
  });

  test('rejects a non-ISO expiry and a non-positive ttl', () => {
    expect(() =>
      browserCallTokenSchema.parse({
        token: 't',
        identity: 'u',
        expiresAt: 'nope',
        ttlSeconds: 60,
      }),
    ).toThrow();
    expect(() =>
      browserCallTokenSchema.parse({ token: 't', identity: 'u', expiresAt: ISO, ttlSeconds: 0 }),
    ).toThrow();
  });
});

describe('dialOptionsSchema', () => {
  test('accepts booleans', () => {
    expect(dialOptionsSchema.parse({ record: true, consentAnnouncement: false })).toEqual({
      record: true,
      consentAnnouncement: false,
    });
  });

  test('rejects non-boolean fields', () => {
    expect(() => dialOptionsSchema.parse({ record: 'yes', consentAnnouncement: false })).toThrow();
  });
});

describe('dialResultSchema / smsResultSchema', () => {
  test('accept non-empty ids', () => {
    expect(dialResultSchema.parse({ callSid: 'CA1' })).toEqual({ callSid: 'CA1' });
    expect(smsResultSchema.parse({ sid: 'SM1' })).toEqual({ sid: 'SM1' });
  });

  test('reject empty ids', () => {
    expect(() => dialResultSchema.parse({ callSid: '' })).toThrow();
    expect(() => smsResultSchema.parse({ sid: '' })).toThrow();
  });
});

describe('voicemailDropSchema', () => {
  test('accepts a full record', () => {
    const drop = { callSid: 'CA1', recordingRef: 'rec://vm', at: ISO };
    expect(voicemailDropSchema.parse(drop)).toEqual(drop);
  });

  test('rejects a missing recordingRef', () => {
    expect(() => voicemailDropSchema.parse({ callSid: 'CA1', at: ISO })).toThrow();
  });
});

describe('inboundSmsEventSchema', () => {
  test('accepts a parsed inbound SMS', () => {
    const sms = {
      messageSid: 'SM1',
      from: '+15550001111',
      to: '+15550002222',
      body: 'STOP',
      numMedia: 0,
      receivedAt: ISO,
    };
    expect(inboundSmsEventSchema.parse(sms)).toEqual(sms);
  });

  test('rejects a missing messageSid', () => {
    expect(() =>
      inboundSmsEventSchema.parse({
        from: '+1',
        to: '+2',
        body: 'hi',
        numMedia: 0,
        receivedAt: ISO,
      }),
    ).toThrow();
  });
});

describe('callLifecycleTypeSchema', () => {
  test('enumerates the ten lifecycle types', () => {
    expect(callLifecycleTypeSchema.options).toEqual([
      'queued',
      'ringing',
      'recording_consent_played',
      'answered',
      'recording_started',
      'recording_completed',
      'completed',
      'failed',
      'voicemail',
      'missed',
    ]);
  });
});

describe('callLifecycleEventSchema', () => {
  const base = { callSid: 'CA1', sequence: 0, at: ISO };

  test('parses each simple marker event', () => {
    for (const type of [
      'queued',
      'ringing',
      'answered',
      'missed',
      'recording_consent_played',
    ] as const) {
      const parsed = callLifecycleEventSchema.parse({ type, ...base });
      expect(parsed.type).toBe(type);
    }
  });

  test('recording_completed requires a recordingRef, recordingSid and duration', () => {
    const ok: CallLifecycleEvent = {
      type: 'recording_completed',
      ...base,
      recordingSid: 'RE1',
      recordingRef: 'rec://1',
      durationS: 30,
    };
    expect(callLifecycleEventSchema.parse(ok)).toEqual(ok);
    expect(() =>
      callLifecycleEventSchema.parse({ type: 'recording_completed', ...base, recordingSid: 'RE1' }),
    ).toThrow();
  });

  test('voicemail carries a recording ref and duration', () => {
    const vm: CallLifecycleEvent = {
      type: 'voicemail',
      ...base,
      recordingRef: 'rec://vm',
      recordingDurationS: 12,
    };
    expect(callLifecycleEventSchema.parse(vm)).toEqual(vm);
  });

  test('completed carries duration and the voicemailDropped flag', () => {
    const done: CallLifecycleEvent = {
      type: 'completed',
      ...base,
      durationS: 42,
      voicemailDropped: false,
    };
    expect(callLifecycleEventSchema.parse(done)).toEqual(done);
  });

  test('failed requires a non-empty reason', () => {
    expect(() => callLifecycleEventSchema.parse({ type: 'failed', ...base, reason: '' })).toThrow();
  });

  test('rejects an unknown discriminant', () => {
    expect(() => callLifecycleEventSchema.parse({ type: 'exploded', ...base })).toThrow();
  });

  test('rejects a negative sequence', () => {
    expect(() =>
      callLifecycleEventSchema.parse({ type: 'queued', ...base, sequence: -1 }),
    ).toThrow();
  });
});
