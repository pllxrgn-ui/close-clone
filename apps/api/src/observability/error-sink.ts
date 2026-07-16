import { randomUUID } from 'node:crypto';

import { errSerializer, type SerializableError } from './logging.ts';
import { redactDeep } from './redaction.ts';

/**
 * Error-tracking adapter (Task 5e). A tiny seam the composition root wires into
 * Fastify's error path (via the http-observability plugin's `onError` hook,
 * which never touches the reply — so the CONTRACTS §C8 response mapping is
 * unchanged). Capturing an exception is always fire-and-forget and must never
 * throw into the request path.
 *
 * Two production shapes, chosen by config:
 *   - default — a console/no-op sink (no external account, MOCK_MODE-safe);
 *   - DSN-gated — a Sentry/GlitchTip HTTP sink using a DEPENDENCY-FREE transport
 *     (global `fetch`; no SDK added). GlitchTip speaks the Sentry store API, so
 *     one code path covers both.
 *
 * All context is run through {@link redactDeep} before it leaves the process —
 * an error captured mid-request carries headers, and those must not ship a
 * bearer token to a third party.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export interface ErrorContext {
  [key: string]: unknown;
}

export interface ErrorSink {
  /** Record an exception with optional context. Never throws; never blocks. */
  captureException(err: unknown, ctx?: ErrorContext): void;
}

export interface MinimalErrorLogger {
  error(payload: object, message?: string): void;
}

/** POST transport: `(url, headers, body) => Promise<void>`. Injected in tests. */
export type ErrorSinkTransport = (
  url: string,
  headers: Record<string, string>,
  body: string,
) => Promise<void> | void;

// --- Error normalization -----------------------------------------------------

function toSerializableError(err: unknown): SerializableError {
  if (typeof err === 'object' && err !== null) return err as SerializableError;
  return { name: 'Error', message: typeof err === 'string' ? err : String(err) };
}

// --- No-op / console sinks ---------------------------------------------------

const consoleLogger: MinimalErrorLogger = {
  error(payload, message) {
    console.error(message ?? '[error-sink] captured exception', payload);
  },
};

/** A sink that discards everything (MOCK_MODE default when telemetry is off). */
export function createNoopErrorSink(): ErrorSink {
  return {
    captureException() {
      /* discard */
    },
  };
}

/** A sink that logs a redacted, C8-tagged payload through a logger (default console). */
export function createConsoleErrorSink(logger: MinimalErrorLogger = consoleLogger): ErrorSink {
  return {
    captureException(err, ctx) {
      try {
        const payload: Record<string, unknown> = { err: errSerializer(toSerializableError(err)) };
        if (ctx !== undefined) payload['context'] = redactDeep(ctx);
        logger.error(payload, 'captured exception');
      } catch {
        // Telemetry must never break the caller.
      }
    },
  };
}

// --- DSN parsing -------------------------------------------------------------

export interface ParsedDsn {
  storeUrl: string;
  publicKey: string;
  secretKey?: string;
}

/**
 * Parse a Sentry/GlitchTip DSN (`{proto}://{publicKey}[:{secret}]@{host}{path}/{projectId}`)
 * into the store endpoint + auth key material. Throws on a malformed DSN or a
 * missing public key / project id.
 */
export function parseSentryDsn(dsn: string): ParsedDsn {
  const url = new URL(dsn); // throws on a non-URL
  const publicKey = url.username;
  if (publicKey.length === 0) throw new Error('Sentry DSN missing public key');
  const secretKey = url.password.length > 0 ? url.password : undefined;

  const trimmed = url.pathname.replace(/\/+$/, '');
  const segments = trimmed.split('/').filter((s) => s.length > 0);
  const projectId = segments.pop();
  if (projectId === undefined || projectId.length === 0) {
    throw new Error('Sentry DSN missing project id');
  }
  const basePath = segments.length > 0 ? `/${segments.join('/')}` : '';
  const storeUrl = `${url.protocol}//${url.host}${basePath}/api/${projectId}/store/`;

  return { storeUrl, publicKey, ...(secretKey !== undefined ? { secretKey } : {}) };
}

function buildAuthHeader(publicKey: string, secretKey: string | undefined): string {
  const parts = [
    'Sentry sentry_version=7',
    'sentry_client=switchboard-api/1.0',
    `sentry_key=${publicKey}`,
  ];
  if (secretKey !== undefined) parts.push(`sentry_secret=${secretKey}`);
  return parts.join(', ');
}

const defaultTransport: ErrorSinkTransport = async (url, headers, body) => {
  await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) });
};

// --- DSN sink ----------------------------------------------------------------

export interface DsnErrorSinkOptions {
  dsn: string;
  transport?: ErrorSinkTransport;
  now?: () => number;
  release?: string;
  serverName?: string;
  /** Called if the transport throws/rejects (kept out of the request path). */
  onError?: (err: unknown) => void;
}

/**
 * A DSN-gated Sentry/GlitchTip sink. Construction throws on a malformed DSN
 * (callers that want graceful degradation use {@link createErrorSinkFromConfig}).
 * Capture builds a minimal Sentry event, redacts context, and fires the
 * transport without awaiting it.
 */
export function createDsnErrorSink(options: DsnErrorSinkOptions): ErrorSink {
  const parsed = parseSentryDsn(options.dsn);
  const transport = options.transport ?? defaultTransport;
  const now = options.now ?? ((): number => Date.now());
  const auth = buildAuthHeader(parsed.publicKey, parsed.secretKey);
  const headers = { 'content-type': 'application/json', 'x-sentry-auth': auth };

  return {
    captureException(err, ctx) {
      try {
        const described = errSerializer(toSerializableError(err));
        const extra: Record<string, unknown> = {
          ...(ctx !== undefined ? (redactDeep(ctx) as Record<string, unknown>) : {}),
          code: described.code,
          stack: described.stack,
        };
        const event = {
          event_id: randomUUID().replace(/-/g, ''),
          timestamp: Math.floor(now() / 1000),
          platform: 'node',
          level: 'error',
          logger: 'switchboard-api',
          ...(options.release !== undefined ? { release: options.release } : {}),
          ...(options.serverName !== undefined ? { server_name: options.serverName } : {}),
          exception: { values: [{ type: described.type, value: described.message }] },
          extra,
        };
        const result = transport(parsed.storeUrl, headers, JSON.stringify(event));
        void Promise.resolve(result).catch((e: unknown) => options.onError?.(e));
      } catch (e) {
        // Build/serialize failure or a synchronous transport throw — swallow.
        options.onError?.(e);
      }
    },
  };
}

// --- Config factory ----------------------------------------------------------

export interface ErrorSinkConfig {
  /** When set + parseable, use the DSN HTTP sink; otherwise the console sink. */
  dsn?: string;
  transport?: ErrorSinkTransport;
  logger?: MinimalErrorLogger;
  release?: string;
  serverName?: string;
  onError?: (err: unknown) => void;
}

/**
 * The factory the composition root calls. A configured, parseable DSN yields the
 * HTTP sink; anything else (no DSN, or a malformed one) degrades to the console
 * sink so a bad env var can never crash boot.
 */
export function createErrorSinkFromConfig(config: ErrorSinkConfig = {}): ErrorSink {
  if (config.dsn !== undefined && config.dsn.length > 0) {
    try {
      return createDsnErrorSink({
        dsn: config.dsn,
        ...(config.transport !== undefined ? { transport: config.transport } : {}),
        ...(config.release !== undefined ? { release: config.release } : {}),
        ...(config.serverName !== undefined ? { serverName: config.serverName } : {}),
        ...(config.onError !== undefined ? { onError: config.onError } : {}),
      });
    } catch {
      // Malformed DSN → fall through to the console sink.
    }
  }
  return createConsoleErrorSink(config.logger);
}
