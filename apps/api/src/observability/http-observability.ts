import type { FastifyInstance } from 'fastify';

import type { ErrorSink } from './error-sink.ts';
import { REQUEST_ID_HEADER, classifyErrorCode, statusToErrorCode } from './logging.ts';

/**
 * HTTP observability plugin (Task 5e). A Fastify plugin factory the composition
 * root registers to add, over the pino config from `logging.ts`:
 *
 *   1. request-id OUT — echo `request.id` (adopted-or-minted by `genRequestId`)
 *      back on the response `x-request-id` header.
 *   2. sampled completion logs — one line per request. Hot reads (GET by default)
 *      at 2xx/3xx are sampled to cut log volume; 4xx/5xx are ALWAYS logged and
 *      C8-tagged. Requires the server to set `disableRequestLogging: true` so
 *      this is the single completion log (see routeWiring in the task report).
 *   3. error capture — `onError` sends the exception to the injected ErrorSink
 *      and logs it with its CONTRACTS §C8 code. `onError` is observation-only: it
 *      never touches the reply, so the C8 response mapping is unchanged.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export interface HttpObservabilityDeps {
  /** Optional error-tracking sink; capture is skipped when omitted. */
  errorSink?: ErrorSink;
  /** Marks a request as a sampleable "hot read". Default: any GET. */
  isHotRoute?: (req: { method: string; url: string }) => boolean;
  /** Deterministic sampler (return true = emit). Overrides {@link sampleRate}. */
  sampler?: () => boolean;
  /** Fraction of hot 2xx/3xx requests to log at info. Default 0.1. */
  sampleRate?: number;
}

const DEFAULT_SAMPLE_RATE = 0.1;

function defaultIsHotRoute(req: { method: string; url: string }): boolean {
  return req.method === 'GET';
}

export function registerHttpObservability(
  app: FastifyInstance,
  deps: HttpObservabilityDeps = {},
): void {
  const isHotRoute = deps.isHotRoute ?? defaultIsHotRoute;
  const sampleRate = deps.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const shouldSample = (): boolean =>
    deps.sampler !== undefined ? deps.sampler() : Math.random() < sampleRate;

  // Requests that errored (onError already logged) — so onResponse does not
  // double-log them. Keyed on the request object; no global type augmentation.
  const errored = new WeakSet<object>();

  app.addHook('onRequest', async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });

  app.addHook('onError', async (request, _reply, error) => {
    errored.add(request);
    deps.errorSink?.captureException(error, {
      reqId: request.id,
      method: request.method,
      url: request.url,
    });
    request.log.error(
      {
        err: error,
        errorCode: classifyErrorCode(error),
        reqId: request.id,
        method: request.method,
        url: request.url,
      },
      'request errored',
    );
  });

  app.addHook('onResponse', async (request, reply) => {
    if (errored.has(request)) return; // already logged by onError

    const status = reply.statusCode;
    const fields = {
      reqId: request.id,
      method: request.method,
      url: request.url,
      statusCode: status,
      responseTimeMs: Math.round(reply.elapsedTime),
    };

    if (status >= 500) {
      request.log.error({ ...fields, errorCode: statusToErrorCode(status) }, 'request completed');
      return;
    }
    if (status >= 400) {
      request.log.warn({ ...fields, errorCode: statusToErrorCode(status) }, 'request completed');
      return;
    }
    // 2xx/3xx: sample hot reads, always log everything else.
    if (isHotRoute(request) && !shouldSample()) return;
    request.log.info(fields, 'request completed');
  });
}
