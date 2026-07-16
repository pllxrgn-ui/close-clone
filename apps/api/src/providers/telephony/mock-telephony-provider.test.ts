import { beforeEach, describe, expect, test } from 'vitest';
import { browserCallTokenSchema, type CallLifecycleType } from '@switchboard/shared/providers';
import { ManualClock, SequentialIds } from '../mock/clock.ts';
import {
  MockTelephonyProvider,
  createMockTelephonyProvider,
  type EmittedTelephonyWebhook,
} from './mock-telephony-provider.ts';
import { defaultOutboundSteps, inboundVoicemailSteps } from './twilio-wire.ts';
import { matchOptOutKeyword } from './opt-out.ts';

const RECORD_ON = { record: true, consentAnnouncement: true } as const;
const RECORD_OFF = { record: false, consentAnnouncement: false } as const;

function types(events: { type: CallLifecycleType }[]): CallLifecycleType[] {
  return events.map((e) => e.type);
}

/** Lifecycle types of delivered webhooks (inbound SMS events surface as 'sms'). */
function deliveredTypes(webhooks: EmittedTelephonyWebhook[]): string[] {
  return webhooks.map((w) => ('type' in w.event ? w.event.type : 'sms'));
}

/** Subscribe a collector to the delivered webhook stream. */
function collect(provider: MockTelephonyProvider): EmittedTelephonyWebhook[] {
  const received: EmittedTelephonyWebhook[] = [];
  provider.emitWebhook((w) => received.push(w));
  return received;
}

describe('MockTelephonyProvider', () => {
  let clock: ManualClock;
  let provider: MockTelephonyProvider;

  beforeEach(() => {
    clock = new ManualClock('2026-07-15T12:00:00.000Z');
    provider = createMockTelephonyProvider({ clock, ids: new SequentialIds() });
  });

  describe('createCallToken', () => {
    test('mints a contract-valid token bound to the user and counts the call', async () => {
      const token = await provider.createCallToken('user-1');
      expect(() => browserCallTokenSchema.parse(token)).not.toThrow();
      expect(token.identity).toBe('user-1');
      expect(new Date(token.expiresAt).getTime()).toBeGreaterThan(clock.now().getTime());
      expect(provider.createCallTokenCount).toBe(1);
    });

    test('rejects an empty userId', async () => {
      await expect(provider.createCallToken('')).rejects.toThrow();
    });
  });

  describe('dial + lifecycle ordering', () => {
    test('an unrecorded call emits queued→ringing→answered→completed with no recording', async () => {
      const { callSid } = await provider.dial('+15550000001', '+15550000002', RECORD_OFF);
      expect(provider.dialCount).toBe(1);
      const events = provider.lifecycleFor(callSid);
      expect(types(events)).toEqual(['queued', 'ringing', 'answered', 'completed']);
      // sequences are 0..n in order
      expect(events.map((e) => e.sequence)).toEqual([0, 1, 2, 3]);
      // no recording refs of any kind (I-REC: record=false)
      expect(events.some((e) => 'recordingSid' in e || 'recordingRef' in e)).toBe(false);
    });

    test('a recorded call plays consent BEFORE recording starts (I-REC)', async () => {
      const { callSid } = await provider.dial('+1', '+2', RECORD_ON);
      const events = provider.lifecycleFor(callSid);
      expect(types(events)).toEqual([
        'queued',
        'ringing',
        'recording_consent_played',
        'answered',
        'recording_started',
        'recording_completed',
        'completed',
      ]);
      const consentIdx = types(events).indexOf('recording_consent_played');
      const firstRecordingIdx = events.findIndex(
        (e) => e.type === 'recording_started' || e.type === 'recording_completed',
      );
      expect(consentIdx).toBeGreaterThanOrEqual(0);
      expect(firstRecordingIdx).toBeGreaterThan(consentIdx);
    });

    test('recording_started and recording_completed share a recording sid + carry a ref', async () => {
      const { callSid } = await provider.dial('+1', '+2', RECORD_ON);
      const events = provider.lifecycleFor(callSid);
      const started = events.find((e) => e.type === 'recording_started');
      const completed = events.find((e) => e.type === 'recording_completed');
      expect(
        started?.type === 'recording_started' && completed?.type === 'recording_completed',
      ).toBe(true);
      if (started?.type === 'recording_started' && completed?.type === 'recording_completed') {
        expect(completed.recordingSid).toBe(started.recordingSid);
        expect(completed.recordingRef).toContain(started.recordingSid);
        expect(completed.durationS).toBeGreaterThan(0);
      }
    });

    test('record=true without consent arms NO recording (I-REC safe default)', async () => {
      const { callSid } = await provider.dial('+1', '+2', {
        record: true,
        consentAnnouncement: false,
      });
      const events = provider.lifecycleFor(callSid);
      expect(types(events)).toEqual(['queued', 'ringing', 'answered', 'completed']);
      expect(events.some((e) => e.type === 'recording_started')).toBe(false);
    });

    test('dial validates opts and requires from/to', async () => {
      await expect(provider.dial('', '+2', RECORD_OFF)).rejects.toThrow();
      await expect(provider.dial('+1', '', RECORD_OFF)).rejects.toThrow();
      // @ts-expect-error — opts must satisfy DialOptions
      await expect(provider.dial('+1', '+2', { record: 'yes' })).rejects.toThrow();
    });
  });

  describe('defaultOutboundSteps (I-REC at the step level)', () => {
    test('no recording steps when record is off', () => {
      const steps = defaultOutboundSteps(RECORD_OFF).map((s) => s.type);
      expect(steps).toEqual(['queued', 'ringing', 'answered', 'completed']);
    });

    test('consent precedes recording when armed', () => {
      const steps = defaultOutboundSteps(RECORD_ON).map((s) => s.type);
      expect(steps.indexOf('recording_consent_played')).toBeLessThan(
        steps.indexOf('recording_started'),
      );
    });
  });

  describe('emitWebhook + pump (clock-gated delivery)', () => {
    test('delivers signed, verifiable Twilio wire payloads for voice events', async () => {
      const received = collect(provider);
      const { callSid } = await provider.dial('+15550000001', '+15550000002', RECORD_OFF);
      const delivered = provider.pump();

      expect(delivered).toHaveLength(4);
      expect(received).toHaveLength(4);
      for (const w of delivered) {
        expect(w.channel).toBe('voice');
        expect(w.wire).toBeDefined();
        if (w.wire) {
          expect(w.wire.url).toBe('https://switchboard.test/wh/twilio/status');
          expect(w.wire.params.CallSid).toBe(callSid);
          expect(w.wire.params.AccountSid).toMatch(/^AC/);
          // the provider's own verifyWebhook accepts what it emitted
          expect(provider.verifyWebhook(w.wire.headers, w.wire.rawBody, w.wire.url)).toBe(true);
        }
      }
    });

    test('the consent marker is delivered on the stream but has no Twilio wire body', async () => {
      const received = collect(provider);
      await provider.dial('+1', '+2', RECORD_ON);
      provider.pump();
      const consent = received.find(
        (w) => 'type' in w.event && w.event.type === 'recording_consent_played',
      );
      expect(consent).toBeDefined();
      expect(consent?.wire).toBeUndefined();
    });

    test('respects per-step delays via the injected clock — no real timers', async () => {
      const sid = provider.peekNextCallSid();
      provider.scriptLifecycle(sid, [
        { type: 'ringing' },
        { type: 'answered', delayMs: 1000 },
        { type: 'completed', delayMs: 1000 },
      ]);
      const { callSid } = await provider.dial('+1', '+2', RECORD_OFF);
      expect(callSid).toBe(sid);

      // t0: only the 0-delay ringing is due.
      expect(deliveredTypes(provider.pump())).toEqual(['ringing']);
      expect(provider.pendingWebhookCount).toBe(2);

      clock.advance(1000);
      expect(deliveredTypes(provider.pump())).toEqual(['answered']);

      clock.advance(1000);
      expect(deliveredTypes(provider.pump())).toEqual(['completed']);
      expect(provider.pendingWebhookCount).toBe(0);
    });

    test('unsubscribe stops further delivery to a handler', async () => {
      const received: EmittedTelephonyWebhook[] = [];
      const unsubscribe = provider.emitWebhook((w) => received.push(w));
      await provider.dial('+1', '+2', RECORD_OFF);
      provider.pump();
      const countAfterFirst = received.length;
      unsubscribe();
      await provider.dial('+1', '+2', RECORD_OFF);
      provider.pump();
      expect(received.length).toBe(countAfterFirst);
    });
  });

  describe('verifyWebhook (ingress accept/reject)', () => {
    let wire: NonNullable<EmittedTelephonyWebhook['wire']>;

    beforeEach(async () => {
      const received = collect(provider);
      await provider.dial('+1', '+2', RECORD_OFF);
      provider.pump();
      const first = received[0];
      if (first?.wire === undefined) throw new Error('expected a wire payload');
      wire = first.wire;
    });

    test('accepts the untampered payload', () => {
      expect(provider.verifyWebhook(wire.headers, wire.rawBody, wire.url)).toBe(true);
    });

    test('rejects a tampered body, url, and signature', () => {
      expect(provider.verifyWebhook(wire.headers, `${wire.rawBody}&x=1`, wire.url)).toBe(false);
      expect(provider.verifyWebhook(wire.headers, wire.rawBody, `${wire.url}?x=1`)).toBe(false);
      expect(provider.verifyWebhook({ 'X-Twilio-Signature': 'bad' }, wire.rawBody, wire.url)).toBe(
        false,
      );
    });

    test('rejects a missing signature header', () => {
      expect(provider.verifyWebhook({}, wire.rawBody, wire.url)).toBe(false);
    });
  });

  describe('sendSms idempotency + counters (I-QUIET/I-DNC affordances)', () => {
    test('same idempotency key ⇒ same sid, one logical send', async () => {
      const first = await provider.sendSms('+1', '+2', 'hi', 'intent-1');
      const second = await provider.sendSms('+1', '+2', 'hi', 'intent-1');
      expect(second).toEqual(first);
      expect(provider.deliveredSmsCount).toBe(1);
      expect(provider.getOutboundSms()).toHaveLength(1);
    });

    test('counts raw calls per key and in total even when deduped', async () => {
      await provider.sendSms('+1', '+2', 'a', 'intent-1');
      await provider.sendSms('+1', '+2', 'a', 'intent-1');
      await provider.sendSms('+1', '+2', 'b', 'intent-2');
      expect(provider.sendSmsCountForKey('intent-1')).toBe(2);
      expect(provider.sendSmsCountForKey('intent-2')).toBe(1);
      expect(provider.sendSmsCount).toBe(3);
      expect(provider.deliveredSmsCount).toBe(2);
    });

    test('different keys are independent sends with distinct sids', async () => {
      const a = await provider.sendSms('+1', '+2', 'x', 'k1');
      const b = await provider.sendSms('+1', '+2', 'x', 'k2');
      expect(a.sid).not.toBe(b.sid);
    });

    test('rejects empty key and empty from/to', async () => {
      await expect(provider.sendSms('+1', '+2', 'x', '')).rejects.toThrow();
      await expect(provider.sendSms('', '+2', 'x', 'k')).rejects.toThrow();
      await expect(provider.sendSms('+1', '', 'x', 'k')).rejects.toThrow();
    });

    test('interceptor fires on entry, before the idempotency short-circuit', async () => {
      let calls = 0;
      provider.setSmsSendInterceptor(() => {
        calls += 1;
      });
      await provider.sendSms('+1', '+2', 'x', 'k1');
      await provider.sendSms('+1', '+2', 'x', 'k1'); // deduped, but interceptor still fires
      expect(calls).toBe(2);
    });
  });

  describe('dropVoicemail', () => {
    test('records and counts a drop, appending a terminal completed event', async () => {
      const sid = provider.peekNextCallSid();
      provider.scriptLifecycle(sid, [{ type: 'ringing' }, { type: 'answered' }]);
      const { callSid } = await provider.dial('+1', '+2', RECORD_OFF);
      await provider.dropVoicemail(callSid, 'rec://drop-1');

      expect(provider.dropVoicemailCount).toBe(1);
      const drops = provider.getVoicemailDrops();
      expect(drops).toHaveLength(1);
      expect(drops[0]?.recordingRef).toBe('rec://drop-1');

      const events = provider.lifecycleFor(callSid);
      expect(types(events)).toEqual(['ringing', 'answered', 'completed']);
      const last = events[events.length - 1];
      expect(last?.type === 'completed' && last.voicemailDropped).toBe(true);
      expect(last?.sequence).toBe(2);
    });

    test('rejects an unknown callSid and an empty recordingRef', async () => {
      await expect(provider.dropVoicemail('CA-unknown', 'rec://x')).rejects.toThrow();
      const { callSid } = await provider.dial('+1', '+2', RECORD_OFF);
      await expect(provider.dropVoicemail(callSid, '')).rejects.toThrow();
    });
  });

  describe('inbound voicemail stream (3c/3d consume the recording ref)', () => {
    test('an inbound call to voicemail yields a recording ref + duration', () => {
      const received = collect(provider);
      const { callSid } = provider.injectInboundCall({
        from: '+15551230000',
        to: '+15559990000',
        steps: inboundVoicemailSteps(),
      });
      const events = provider.lifecycleFor(callSid);
      expect(types(events)).toEqual(['ringing', 'voicemail']);
      const vm = events[1];
      expect(vm?.type).toBe('voicemail');
      if (vm?.type === 'voicemail') {
        expect(vm.recordingRef.length).toBeGreaterThan(0);
        expect(vm.recordingDurationS).toBeGreaterThan(0);
      }

      provider.pump();
      const vmWebhook = received.find((w) => 'type' in w.event && w.event.type === 'voicemail');
      expect(vmWebhook?.wire?.params.RecordingUrl).toBeDefined();
      expect(vmWebhook?.wire?.params.RecordingDuration).toBeDefined();
      if (vmWebhook?.wire) {
        expect(
          provider.verifyWebhook(
            vmWebhook.wire.headers,
            vmWebhook.wire.rawBody,
            vmWebhook.wire.url,
          ),
        ).toBe(true);
      }
    });
  });

  describe('inbound SMS + opt-out (I-QUIET)', () => {
    test('each STOP-family keyword is delivered verbatim and classifies as opt-out', () => {
      for (const keyword of ['STOP', 'UNSUBSCRIBE', 'QUIT', 'CANCEL', 'END'] as const) {
        const p = createMockTelephonyProvider({
          clock: new ManualClock(),
          ids: new SequentialIds(),
        });
        const received = collect(p);
        p.injectInboundSms({ from: '+15550001111', to: '+15550002222', body: keyword });
        p.pump();
        const sms = received[0];
        expect(sms?.channel).toBe('sms');
        expect(sms !== undefined && 'body' in sms.event).toBe(true);
        if (sms && 'body' in sms.event) {
          expect(sms.event.body).toBe(keyword);
          expect(matchOptOutKeyword(sms.event.body)).toBe(keyword);
        }
        expect(sms?.wire?.params.Body).toBe(keyword);
        expect(sms?.wire?.params.MessageSid).toMatch(/^SM/);
        if (sms?.wire) {
          expect(p.verifyWebhook(sms.wire.headers, sms.wire.rawBody, sms.wire.url)).toBe(true);
        }
      }
    });

    test('a normal inbound SMS is not an opt-out', () => {
      const received = collect(provider);
      provider.injectInboundSms({ from: '+1', to: '+2', body: 'thanks!' });
      provider.pump();
      const sms = received[0];
      if (sms && 'body' in sms.event) {
        expect(matchOptOutKeyword(sms.event.body)).toBeNull();
      }
      expect(sms?.wire?.url).toBe('https://switchboard.test/wh/twilio/sms');
    });
  });

  describe('determinism / byte-identical replay', () => {
    async function run(): Promise<string> {
      const p = createMockTelephonyProvider({
        clock: new ManualClock('2026-07-15T12:00:00.000Z'),
        ids: new SequentialIds(),
      });
      const delivered: EmittedTelephonyWebhook[] = [];
      p.emitWebhook((w) => delivered.push(w));
      const token = await p.createCallToken('user-1');
      const dialed = await p.dial('+15550000001', '+15550000002', RECORD_ON);
      await p.sendSms('+15550000001', '+15550000003', 'hi', 'k1');
      p.injectInboundSms({ from: '+15550000003', to: '+15550000001', body: 'STOP' });
      p.pump();
      return JSON.stringify({
        token,
        dialed,
        delivered,
        lifecycle: p.lifecycleFor(dialed.callSid),
      });
    }

    test('two providers driven identically produce identical output', async () => {
      const [a, b] = await Promise.all([run(), run()]);
      expect(a).toBe(b);
    });
  });
});
