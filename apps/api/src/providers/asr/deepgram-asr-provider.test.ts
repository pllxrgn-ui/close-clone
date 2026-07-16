import { describe, expect, test } from 'vitest';
import { transcriptSchema } from '@switchboard/shared/providers';
import {
  DeepgramASRProvider,
  DeepgramApiError,
  createDeepgramASRProvider,
  type DeepgramTransport,
  type DeepgramTransportRequest,
  type DeepgramTransportResponse,
} from './deepgram-asr-provider.ts';

/**
 * Real Deepgram adapter (task 3e) exercised ONLY through a synthetic transport with
 * a RECORDED response — no network, no account (parity with 2b/3b). Asserts the
 * request shape (Token auth, `{url}` body, diarize/utterances flags) and the
 * response→Transcript mapping, including the no-diarization fallback and error path.
 */

function stubTransport(response: DeepgramTransportResponse): {
  transport: DeepgramTransport;
  requests: DeepgramTransportRequest[];
} {
  const requests: DeepgramTransportRequest[] = [];
  return {
    requests,
    transport: {
      async request(req) {
        requests.push(req);
        return response;
      },
    },
  };
}

const DIARIZED = JSON.stringify({
  metadata: { duration: 21.5 },
  results: {
    channels: [{ alternatives: [{ transcript: 'Hello there. We want a quote.' }] }],
    utterances: [
      { speaker: 0, transcript: 'Hello there.', start: 0, end: 2 },
      { speaker: 1, transcript: 'We want a quote.', start: 2, end: 5 },
    ],
  },
});

describe('DeepgramASRProvider', () => {
  test('maps a diarized response to a schema-valid Transcript', async () => {
    const { transport, requests } = stubTransport({ status: 200, body: DIARIZED });
    const asr = createDeepgramASRProvider({ apiKey: 'dg-key', transport });
    const t = await asr.transcribe('https://audio.example/rec.wav');

    expect(() => transcriptSchema.parse(t)).not.toThrow();
    expect(t.text).toBe('Hello there. We want a quote.');
    expect(t.durationS).toBe(21.5);
    expect(t.segments).toEqual([
      { speaker: 'agent', text: 'Hello there.', startS: 0, endS: 2 },
      { speaker: 'customer', text: 'We want a quote.', startS: 2, endS: 5 },
    ]);

    // Request shape: Token auth, JSON {url}, diarize + utterances flags. No network.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.Authorization).toBe('Token dg-key');
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({ url: 'https://audio.example/rec.wav' });
    expect(requests[0]?.url).toContain('diarize=true');
    expect(requests[0]?.url).toContain('utterances=true');
  });

  test('falls back to a single segment when no utterances are present', async () => {
    const body = JSON.stringify({
      metadata: { duration: 4 },
      results: {
        channels: [
          {
            alternatives: [
              {
                transcript: 'One flat transcript.',
                words: [
                  { word: 'One', start: 0.1, end: 0.4 },
                  { word: 'transcript', start: 3.5, end: 4 },
                ],
              },
            ],
          },
        ],
      },
    });
    const { transport } = stubTransport({ status: 200, body });
    const asr = createDeepgramASRProvider({ apiKey: 'k', transport });
    const t = await asr.transcribe('ref');
    expect(t.segments).toEqual([
      { speaker: 'unknown', text: 'One flat transcript.', startS: 0.1, endS: 4 },
    ]);
  });

  test('non-2xx throws DeepgramApiError (failure path)', async () => {
    const { transport } = stubTransport({ status: 402, body: 'nope' });
    const asr = createDeepgramASRProvider({ apiKey: 'k', transport });
    await expect(asr.transcribe('ref')).rejects.toBeInstanceOf(DeepgramApiError);
  });

  test('empty audioRef and empty apiKey are rejected', async () => {
    const { transport } = stubTransport({ status: 200, body: DIARIZED });
    const asr = new DeepgramASRProvider({ apiKey: 'k', transport });
    await expect(asr.transcribe('')).rejects.toThrow(/empty audioRef/);
    expect(() => new DeepgramASRProvider({ apiKey: '', transport })).toThrow(/apiKey/);
  });
});
