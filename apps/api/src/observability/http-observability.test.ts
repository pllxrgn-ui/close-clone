import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  REQUEST_ID_HEADER,
  buildLogController,
  buildLoggerOptions,
  genRequestId,
} from './logging.ts';
import { REDACTED } from './redaction.ts';
import { registerHttpObservability, type HttpObservabilityDeps } from './http-observability.ts';
import type { ErrorSink } from './error-sink.ts';

/**
 * Task 5e — the http-observability plugin, driven through a real Fastify with a
 * capturing pino stream. This is the end-to-end proof of the three logging
 * guarantees: x-request-id in/out, credential redaction (a bearer token must
 * never appear in ANY captured line), sampled hot-route logs, and C8-tagged
 * error logs that capture to the ErrorSink without altering the C8 response.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface LogSink {
  lines: Record<string, unknown>[];
  raw: string[];
  stream: { write(msg: string): void };
}

function makeLogSink(): LogSink {
  const lines: Record<string, unknown>[] = [];
  const raw: string[] = [];
  return {
    lines,
    raw,
    stream: {
      write(msg: string): void {
        raw.push(msg);
        try {
          lines.push(JSON.parse(msg) as Record<string, unknown>);
        } catch {
          /* non-JSON line — ignore */
        }
      },
    },
  };
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app !== undefined) {
    await app.close();
    app = undefined;
  }
});

function buildApp(deps: HttpObservabilityDeps = {}): LogSink {
  const sink = makeLogSink();
  const instance = Fastify({
    logger: buildLoggerOptions({ stream: sink.stream }),
    genReqId: genRequestId,
    requestIdHeader: false,
    logController: buildLogController(),
  });
  registerHttpObservability(instance, deps);
  instance.get('/api/v1/leads', async () => ({ items: [] }));
  instance.post('/api/v1/emails/send', async () => ({ ok: true }));
  instance.get('/dump', async (request) => {
    // A handler that logs the request itself — exercises the redacting serializer
    // on a REAL request carrying a real Authorization header.
    request.log.info({ req: request }, 'handler dump');
    return { ok: true };
  });
  instance.get('/boom', async () => {
    throw new Error('kaboom-secret-in-message');
  });
  instance.get('/notfound', async (_request, reply) =>
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'nope' } }),
  );
  app = instance;
  return sink;
}

function completed(sink: LogSink): Record<string, unknown>[] {
  return sink.lines.filter((l) => l['msg'] === 'request completed');
}

describe('request-id propagation', () => {
  test('echoes a well-formed inbound x-request-id back on the response', async () => {
    buildApp({ sampler: () => true });
    const res = await app!.inject({
      method: 'GET',
      url: '/api/v1/leads',
      headers: { [REQUEST_ID_HEADER]: 'req-abc-123' },
    });
    expect(res.headers[REQUEST_ID_HEADER]).toBe('req-abc-123');
  });

  test('generates and returns a UUID when no id is supplied', async () => {
    buildApp({ sampler: () => true });
    const res = await app!.inject({ method: 'GET', url: '/api/v1/leads' });
    expect(String(res.headers[REQUEST_ID_HEADER])).toMatch(UUID_RE);
  });

  test('does not adopt a hostile (control-char) inbound id', async () => {
    buildApp({ sampler: () => true });
    const res = await app!.inject({
      method: 'GET',
      url: '/api/v1/leads',
      headers: { [REQUEST_ID_HEADER]: 'evil\r\ninjected' },
    });
    expect(String(res.headers[REQUEST_ID_HEADER])).toMatch(UUID_RE);
  });
});

describe('credential redaction (bearer token never appears in logs)', () => {
  test('redacts headers when a real request is logged through the serializer', async () => {
    const sink = buildApp({ sampler: () => true });
    await app!.inject({
      method: 'GET',
      url: '/dump',
      headers: {
        authorization: 'Bearer eyJ.super.secret.token',
        cookie: 'sid=deadbeefvalue',
        'x-api-key': 'live_key_leak',
      },
    });
    const all = sink.raw.join('\n');
    expect(all).not.toContain('eyJ.super.secret.token');
    expect(all).not.toContain('deadbeefvalue');
    expect(all).not.toContain('live_key_leak');
    expect(all).toContain(REDACTED);
    // The dump line still shows the request shape (method/url) — logs stay useful.
    const dump = sink.lines.find((l) => l['msg'] === 'handler dump');
    const req = dump?.['req'] as Record<string, unknown> | undefined;
    expect(req?.['method']).toBe('GET');
    const headers = req?.['headers'] as Record<string, unknown> | undefined;
    expect(headers?.['authorization']).toBe(REDACTED);
  });

  test('pino redact censors a credential logged directly (defense in depth)', async () => {
    const sink = buildApp({ sampler: () => true });
    app!.get('/manual', async (request) => {
      request.log.info({ authorization: 'Bearer manual-leak-xyz' }, 'manual');
      return {};
    });
    await app!.inject({ method: 'GET', url: '/manual' });
    const all = sink.raw.join('\n');
    expect(all).not.toContain('manual-leak-xyz');
  });

  test('a normal request never emits the Authorization token anywhere', async () => {
    const sink = buildApp({ sampler: () => true });
    await app!.inject({
      method: 'GET',
      url: '/api/v1/leads',
      headers: { authorization: 'Bearer plain-request-secret' },
    });
    expect(sink.raw.join('\n')).not.toContain('plain-request-secret');
  });
});

describe('sampled hot-route logging', () => {
  test('a sampled-OUT hot GET emits no completion log', async () => {
    const sink = buildApp({ sampler: () => false });
    await app!.inject({ method: 'GET', url: '/api/v1/leads' });
    expect(completed(sink)).toHaveLength(0);
  });

  test('a sampled-IN hot GET emits one info completion log', async () => {
    const sink = buildApp({ sampler: () => true });
    await app!.inject({ method: 'GET', url: '/api/v1/leads' });
    const lines = completed(sink);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['level']).toBe(30); // pino info
    expect(lines[0]?.['method']).toBe('GET');
    expect(lines[0]?.['statusCode']).toBe(200);
    expect(typeof lines[0]?.['responseTimeMs']).toBe('number');
  });

  test('a non-hot POST is always logged regardless of sampling', async () => {
    const sink = buildApp({ sampler: () => false });
    await app!.inject({ method: 'POST', url: '/api/v1/emails/send', payload: {} });
    const lines = completed(sink);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['method']).toBe('POST');
  });

  test('a custom isHotRoute predicate overrides the GET default', async () => {
    const sink = buildApp({ sampler: () => false, isHotRoute: () => false });
    await app!.inject({ method: 'GET', url: '/api/v1/leads' });
    // Nothing is "hot" → nothing is sampled out.
    expect(completed(sink)).toHaveLength(1);
  });
});

describe('error path (C8 tagging + ErrorSink, response unchanged)', () => {
  test('a thrown error is captured, C8-tagged, and logged once', async () => {
    const captureException = vi.fn();
    const errorSink: ErrorSink = { captureException };
    const sink = buildApp({ errorSink, sampler: () => true });

    const res = await app!.inject({ method: 'GET', url: '/boom' });

    // Response mapping is Fastify's default 500 — the plugin did not change it.
    expect(res.statusCode).toBe(500);

    // Captured to the sink exactly once, with request context.
    expect(captureException).toHaveBeenCalledOnce();
    const [err, ctx] = captureException.mock.calls[0] ?? [];
    expect((err as Error).message).toBe('kaboom-secret-in-message');
    expect((ctx as Record<string, unknown>)['method']).toBe('GET');
    expect((ctx as Record<string, unknown>)['url']).toBe('/boom');

    // Logged once at error with the C8 code; no duplicate 'request completed'.
    const errored = sink.lines.filter((l) => l['msg'] === 'request errored');
    expect(errored).toHaveLength(1);
    expect(errored[0]?.['errorCode']).toBe('INTERNAL');
    expect(completed(sink)).toHaveLength(0);
  });

  test('a C8 envelope response (404) is left intact and logged at warn', async () => {
    const sink = buildApp({ sampler: () => false });
    const res = await app!.inject({ method: 'GET', url: '/notfound' });

    // The C8 envelope is untouched by the plugin.
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'nope' } });

    // 4xx is always logged (never sampled out) and tagged.
    const lines = completed(sink);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['level']).toBe(40); // pino warn
    expect(lines[0]?.['errorCode']).toBe('NOT_FOUND');
  });

  test('works with no ErrorSink injected (capture is optional)', async () => {
    const sink = buildApp({ sampler: () => true });
    const res = await app!.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(sink.lines.filter((l) => l['msg'] === 'request errored')).toHaveLength(1);
  });
});
