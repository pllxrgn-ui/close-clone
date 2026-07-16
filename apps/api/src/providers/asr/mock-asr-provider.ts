import { transcriptSchema, type ASRProvider, type Transcript } from '@switchboard/shared/providers';

/**
 * In-memory `ASRProvider` (CONTRACTS §C2) for MOCK_MODE and the AI-feature suites
 * (task 3e). Deterministic and account-free: no network, no Deepgram.
 *
 * Test instrument:
 *  - `scriptTranscript(audioRef, transcript)` pins the transcript a given
 *    `recording_ref` transcribes to, so a summary test can assert on known text.
 *  - Absent a script, `transcribe` DERIVES a stable transcript from the audioRef
 *    string (same ref ⇒ byte-identical transcript), so replays are reproducible.
 *
 * The mock never invents a "confidence" or partial result: I-AI lives above the
 * adapter line — this only produces candidate text; nothing here writes a record.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export interface MockASRProviderOptions {
  /** Pre-seed scripted transcripts keyed by audioRef. */
  transcripts?: Record<string, Transcript>;
}

export class MockASRProvider implements ASRProvider {
  private readonly scripted: Map<string, Transcript>;
  private transcribeCalls = 0;

  constructor(options: MockASRProviderOptions = {}) {
    this.scripted = new Map(Object.entries(options.transcripts ?? {}));
  }

  /** Pin the transcript a given recording ref transcribes to. */
  scriptTranscript(audioRef: string, transcript: Transcript): void {
    // Validate at scripting time so a malformed fixture fails loudly in the test.
    this.scripted.set(audioRef, transcriptSchema.parse(transcript));
  }

  /** Raw `transcribe` call count (parity with the telephony/email mock counters). */
  get calls(): number {
    return this.transcribeCalls;
  }

  async transcribe(audioRef: string): Promise<Transcript> {
    this.transcribeCalls += 1;
    if (audioRef.length === 0) throw new Error('mock ASR: empty audioRef');
    const scripted = this.scripted.get(audioRef);
    if (scripted !== undefined) return scripted;
    return deriveTranscript(audioRef);
  }
}

/**
 * Deterministic canned transcript derived from the audioRef. A short two-party
 * exchange whose customer turn mentions a follow-up, so the derived summary +
 * action items are non-trivial without a scripted transcript.
 */
function deriveTranscript(audioRef: string): Transcript {
  const segments = [
    {
      speaker: 'agent' as const,
      text: `Hi, this is a follow-up call regarding ${audioRef}. Thanks for taking the time.`,
      startS: 0,
      endS: 6,
    },
    {
      speaker: 'customer' as const,
      text: 'Thanks for calling. We are still evaluating and would like a revised quote by Friday.',
      startS: 6,
      endS: 14,
    },
    {
      speaker: 'agent' as const,
      text: 'Understood. I will send the revised quote and schedule a follow-up next week.',
      startS: 14,
      endS: 21,
    },
  ];
  return transcriptSchema.parse({
    text: segments.map((s) => s.text).join(' '),
    segments,
    durationS: 21,
    language: 'en',
  });
}

/** Factory the composition root binds under `MOCK_MODE=1`. */
export function createMockASRProvider(options: MockASRProviderOptions = {}): MockASRProvider {
  return new MockASRProvider(options);
}
