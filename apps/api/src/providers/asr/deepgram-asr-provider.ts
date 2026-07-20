import { z } from 'zod';
import { fetchWithTimeout } from '../../lib/fetch-with-timeout.ts';
import {
  transcriptSchema,
  type ASRProvider,
  type Transcript,
  type TranscriptSegment,
} from '@switchboard/shared/providers';

/**
 * Real Deepgram `ASRProvider` (CONTRACTS §C2). Used when `MOCK_MODE` is off; the
 * mock (task 3e) drives every engine/feature test. This adapter is exercised ONLY
 * by its own unit tests, which inject a synthetic {@link DeepgramTransport}
 * returning a RECORDED Deepgram response — no network, no Deepgram account —
 * exactly like 2b's `GmailEmailProvider` and 3b's `TwilioTelephonyProvider`.
 * REAL-mode wiring against live Deepgram is a HUMAN_TODO checkpoint.
 *
 * `audioRef` is the recording handle stored on `calls.recording_ref` (§C1). In real
 * mode it is an HTTPS URL to the (encrypted-at-rest) recording; the adapter passes
 * it to Deepgram's pre-recorded `listen` endpoint as `{ url }`. The referenced audio
 * is a consent-gated recording (I-REC gates its creation upstream); transcription
 * itself writes nothing — I-AI applies to the summary that follows, not here.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

const DEFAULT_API_BASE = 'https://api.deepgram.com';

// --- Transport seam ---------------------------------------------------------

export interface DeepgramTransportRequest {
  method: 'POST';
  url: string;
  headers: Record<string, string>;
  /** JSON body — `{ url }` for a pre-recorded remote audio handle. */
  body: string;
}

export interface DeepgramTransportResponse {
  status: number;
  body: string;
}

/** The HTTP seam. Tests inject a synthetic implementation; prod binds `fetch`. */
export interface DeepgramTransport {
  request(req: DeepgramTransportRequest): Promise<DeepgramTransportResponse>;
}

/** Thrown when Deepgram returns a non-2xx (engine wraps as C8 PROVIDER_ERROR). */
export class DeepgramApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'DeepgramApiError';
    this.status = status;
  }
}

export interface DeepgramASRConfig {
  apiKey: string;
  transport: DeepgramTransport;
  apiBase?: string;
  /** Deepgram model + features query string (diarization + utterances on). */
  model?: string;
}

// --- Deepgram response shapes (only the fields we consume) ------------------

const wordSchema = z.object({
  word: z.string(),
  start: z.number(),
  end: z.number(),
  speaker: z.number().int().nonnegative().optional(),
});

const utteranceSchema = z.object({
  speaker: z.number().int().nonnegative().optional(),
  transcript: z.string(),
  start: z.number(),
  end: z.number(),
});

const deepgramResponseSchema = z.object({
  metadata: z.object({ duration: z.number().nonnegative().optional() }).optional(),
  results: z.object({
    channels: z
      .array(
        z.object({
          alternatives: z
            .array(
              z.object({
                transcript: z.string(),
                words: z.array(wordSchema).optional(),
              }),
            )
            .min(1),
        }),
      )
      .min(1),
    utterances: z.array(utteranceSchema).optional(),
  }),
});

function speakerLabel(speaker: number | undefined): TranscriptSegment['speaker'] {
  if (speaker === 0) return 'agent';
  if (speaker === 1) return 'customer';
  return 'unknown';
}

export class DeepgramASRProvider implements ASRProvider {
  private readonly apiKey: string;
  private readonly transport: DeepgramTransport;
  private readonly apiBase: string;
  private readonly model: string;

  constructor(config: DeepgramASRConfig) {
    if (config.apiKey.length === 0) throw new Error('deepgram: apiKey is required');
    this.apiKey = config.apiKey;
    this.transport = config.transport;
    this.apiBase = config.apiBase ?? DEFAULT_API_BASE;
    this.model = config.model ?? 'nova-2';
  }

  async transcribe(audioRef: string): Promise<Transcript> {
    if (audioRef.length === 0) throw new Error('deepgram transcribe: empty audioRef');
    const url = `${this.apiBase}/v1/listen?model=${encodeURIComponent(
      this.model,
    )}&diarize=true&utterances=true&punctuate=true`;
    const res = await this.transport.request({
      method: 'POST',
      url,
      headers: {
        Authorization: `Token ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: audioRef }),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new DeepgramApiError(res.status, `deepgram listen failed with status ${res.status}`);
    }
    const parsed = deepgramResponseSchema.parse(JSON.parse(res.body));
    return toTranscript(parsed);
  }
}

function toTranscript(parsed: z.infer<typeof deepgramResponseSchema>): Transcript {
  const alternative = parsed.results.channels[0]?.alternatives[0];
  const flatText = alternative?.transcript ?? '';
  const segments: TranscriptSegment[] = [];

  if (parsed.results.utterances !== undefined && parsed.results.utterances.length > 0) {
    for (const u of parsed.results.utterances) {
      segments.push({
        speaker: speakerLabel(u.speaker),
        text: u.transcript,
        startS: u.start,
        endS: u.end,
      });
    }
  } else if (flatText.length > 0) {
    // No diarization: one segment spanning the whole recording.
    const words = alternative?.words ?? [];
    segments.push({
      speaker: 'unknown',
      text: flatText,
      startS: words[0]?.start ?? 0,
      endS: words[words.length - 1]?.end ?? parsed.metadata?.duration ?? 0,
    });
  }

  const text = flatText.length > 0 ? flatText : segments.map((s) => s.text).join(' ');
  return transcriptSchema.parse({
    text,
    segments,
    ...(parsed.metadata?.duration !== undefined ? { durationS: parsed.metadata.duration } : {}),
    language: 'en',
  });
}

/** Production HTTP transport over global `fetch` (never exercised by the suite). */
export class FetchDeepgramTransport implements DeepgramTransport {
  async request(req: DeepgramTransportRequest): Promise<DeepgramTransportResponse> {
    const res = await fetchWithTimeout(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
    });
    return { status: res.status, body: await res.text() };
  }
}

/** Factory the composition root binds when `MOCK_MODE` is off (real Deepgram). */
export function createDeepgramASRProvider(config: DeepgramASRConfig): DeepgramASRProvider {
  return new DeepgramASRProvider(config);
}
