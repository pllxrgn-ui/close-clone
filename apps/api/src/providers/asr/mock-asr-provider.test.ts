import { describe, expect, test } from 'vitest';
import { transcriptSchema } from '@switchboard/shared/providers';
import { MockASRProvider, createMockASRProvider } from './mock-asr-provider.ts';

/**
 * MockASR (task 3e): deterministic, account-free transcription. Same audioRef ⇒
 * byte-identical transcript; a scripted transcript overrides the derivation; an
 * empty ref is a hard error. Nothing here writes a record (I-AI lives above).
 */

describe('MockASRProvider', () => {
  test('derives a stable, schema-valid transcript from the audioRef', async () => {
    const asr = createMockASRProvider();
    const a = await asr.transcribe('rec-123');
    const b = await asr.transcribe('rec-123');
    expect(() => transcriptSchema.parse(a)).not.toThrow();
    expect(a).toEqual(b); // deterministic
    expect(a.segments.length).toBeGreaterThan(0);
    expect(a.text.length).toBeGreaterThan(0);
    expect(a.text).toContain('rec-123');
  });

  test('different refs derive different transcripts', async () => {
    const asr = createMockASRProvider();
    const a = await asr.transcribe('rec-a');
    const b = await asr.transcribe('rec-b');
    expect(a.text).not.toEqual(b.text);
  });

  test('scriptTranscript pins the transcript for a ref', async () => {
    const asr = new MockASRProvider();
    asr.scriptTranscript('rec-x', {
      text: 'Scripted line one. Scripted line two.',
      segments: [{ speaker: 'customer', text: 'Scripted line one.', startS: 0, endS: 3 }],
      durationS: 3,
    });
    const t = await asr.transcribe('rec-x');
    expect(t.text).toBe('Scripted line one. Scripted line two.');
  });

  test('constructor pre-seeds scripted transcripts', async () => {
    const asr = createMockASRProvider({
      transcripts: {
        'rec-seed': { text: 'seeded', segments: [] },
      },
    });
    const t = await asr.transcribe('rec-seed');
    expect(t.text).toBe('seeded');
  });

  test('empty audioRef throws (failure path)', async () => {
    const asr = createMockASRProvider();
    await expect(asr.transcribe('')).rejects.toThrow(/empty audioRef/);
  });

  test('scriptTranscript rejects a malformed transcript at scripting time', () => {
    const asr = new MockASRProvider();
    expect(() =>
      // startS must be a number; a string fails the DTO schema loudly in the test.
      asr.scriptTranscript('bad', {
        text: 'x',
        segments: [{ speaker: 'agent', text: 'x', startS: 'nope', endS: 1 }],
      } as never),
    ).toThrow();
  });

  test('counts transcribe calls', async () => {
    const asr = new MockASRProvider();
    await asr.transcribe('a');
    await asr.transcribe('b');
    expect(asr.calls).toBe(2);
  });
});
