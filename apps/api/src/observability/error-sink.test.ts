import { describe, expect, test, vi } from 'vitest';

import { REDACTED } from './redaction.ts';
import {
  createConsoleErrorSink,
  createDsnErrorSink,
  createErrorSinkFromConfig,
  createNoopErrorSink,
  parseSentryDsn,
  type ErrorSinkTransport,
} from './error-sink.ts';

/**
 * Task 5e — the error-tracking adapter. Proves DSN parsing (Sentry/GlitchTip),
 * the dependency-free HTTP transport shape, that context is redacted before it
 * leaves the process, and that capturing an exception is always fire-and-forget
 * and never throws into the request path.
 */

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function recordingTransport(): { sent: Sent[]; transport: ErrorSinkTransport } {
  const sent: Sent[] = [];
  const transport: ErrorSinkTransport = async (url, headers, body) => {
    sent.push({ url, headers, body });
  };
  return { sent, transport };
}

describe('parseSentryDsn', () => {
  test('parses a standard Sentry DSN into store URL + public key', () => {
    const parsed = parseSentryDsn('https://abc123@o42.ingest.sentry.io/98765');
    expect(parsed.publicKey).toBe('abc123');
    expect(parsed.secretKey).toBeUndefined();
    expect(parsed.storeUrl).toBe('https://o42.ingest.sentry.io/api/98765/store/');
  });

  test('parses a self-hosted GlitchTip DSN with a path prefix', () => {
    const parsed = parseSentryDsn('https://key@glitchtip.example.com/sub/path/7');
    expect(parsed.storeUrl).toBe('https://glitchtip.example.com/sub/path/api/7/store/');
  });

  test('captures a legacy secret key when present', () => {
    const parsed = parseSentryDsn('https://pub:sec@host.tld/3');
    expect(parsed.publicKey).toBe('pub');
    expect(parsed.secretKey).toBe('sec');
  });

  test('throws on a malformed DSN', () => {
    expect(() => parseSentryDsn('not a url')).toThrow();
  });

  test('throws when the project id is missing', () => {
    expect(() => parseSentryDsn('https://pub@host.tld/')).toThrow();
  });
});

describe('createDsnErrorSink', () => {
  test('posts a Sentry event to the store URL with an auth header', () => {
    const { sent, transport } = recordingTransport();
    const sink = createDsnErrorSink({
      dsn: 'https://abc123@o42.ingest.sentry.io/98765',
      transport,
    });

    sink.captureException(new Error('kaboom'), { reqId: 'r1' });

    expect(sent).toHaveLength(1);
    const call = sent[0];
    expect(call?.url).toBe('https://o42.ingest.sentry.io/api/98765/store/');
    expect(call?.headers['x-sentry-auth']).toContain('sentry_key=abc123');
    expect(call?.headers['content-type']).toBe('application/json');
    const event = JSON.parse(call?.body ?? '{}') as {
      exception: { values: { type: string; value: string }[] };
      extra: Record<string, unknown>;
    };
    expect(event.exception.values[0]?.value).toBe('kaboom');
    expect(event.exception.values[0]?.type).toBe('Error');
    expect(event.extra['reqId']).toBe('r1');
  });

  test('redacts credential context before it leaves the process', () => {
    const { sent, transport } = recordingTransport();
    const sink = createDsnErrorSink({ dsn: 'https://k@h.tld/1', transport });

    sink.captureException(new Error('boom'), {
      headers: { authorization: 'Bearer do-not-leak-me' },
    });

    const body = sent[0]?.body ?? '';
    expect(body).not.toContain('do-not-leak-me');
    expect(body).toContain(REDACTED);
  });

  test('is fire-and-forget: a throwing transport never propagates', () => {
    const onError = vi.fn();
    const sink = createDsnErrorSink({
      dsn: 'https://k@h.tld/1',
      transport: () => {
        throw new Error('network down');
      },
      onError,
    });
    expect(() => sink.captureException(new Error('boom'))).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();
  });

  test('a rejected transport promise is swallowed', async () => {
    const onError = vi.fn();
    const sink = createDsnErrorSink({
      dsn: 'https://k@h.tld/1',
      transport: () => Promise.reject(new Error('timeout')),
      onError,
    });
    sink.captureException(new Error('boom'));
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe('createNoopErrorSink', () => {
  test('captures without doing anything and never throws', () => {
    const sink = createNoopErrorSink();
    expect(() => sink.captureException(new Error('x'), { a: 1 })).not.toThrow();
  });
});

describe('createConsoleErrorSink', () => {
  test('logs a redacted, C8-tagged payload through the injected logger', () => {
    const error = vi.fn();
    const sink = createConsoleErrorSink({ error });
    sink.captureException(Object.assign(new Error('dupe'), { code: 'CONFLICT' }), {
      authorization: 'Bearer nope',
    });
    expect(error).toHaveBeenCalledOnce();
    const [payload] = error.mock.calls[0] ?? [];
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('Bearer nope');
    expect(serialized).toContain('CONFLICT');
  });

  test('never throws even if the underlying logger throws', () => {
    const sink = createConsoleErrorSink({
      error: () => {
        throw new Error('logger exploded');
      },
    });
    expect(() => sink.captureException(new Error('x'))).not.toThrow();
  });
});

describe('createErrorSinkFromConfig', () => {
  test('uses the DSN HTTP sink when a DSN is configured', () => {
    const { sent, transport } = recordingTransport();
    const sink = createErrorSinkFromConfig({ dsn: 'https://k@h.tld/9', transport });
    sink.captureException(new Error('boom'));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('https://h.tld/api/9/store/');
  });

  test('falls back to the console sink when no DSN is set', () => {
    const error = vi.fn();
    const sink = createErrorSinkFromConfig({ logger: { error } });
    sink.captureException(new Error('boom'));
    expect(error).toHaveBeenCalledOnce();
  });

  test('a malformed DSN degrades to the console sink instead of crashing boot', () => {
    const error = vi.fn();
    const sink = createErrorSinkFromConfig({ dsn: 'garbage', logger: { error } });
    expect(() => sink.captureException(new Error('boom'))).not.toThrow();
    expect(error).toHaveBeenCalledOnce();
  });
});
