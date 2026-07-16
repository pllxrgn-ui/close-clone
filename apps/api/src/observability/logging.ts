import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

import { LogController } from 'fastify';

import { ERROR_STATUS, type ErrorCode } from '../routes/http.ts';
import { REDACTED, redactHeaders } from './redaction.ts';

/**
 * Structured logging config for Fastify's bundled pino (Task 5e, ARCHITECTURE
 * §8). Everything here is a pure factory the composition root feeds to
 * `Fastify({ logger, genReqId, requestIdHeader, disableRequestLogging })` — no
 * `process.env` reads, no side effects, so it is trivially unit-testable.
 *
 * Three guarantees this module underwrites:
 *   1. request-id in/out — {@link genRequestId} adopts a well-formed inbound
 *      `x-request-id` (log-injection-guarded) or mints a UUID; the
 *      http-observability plugin echoes it back on the response.
 *   2. redaction — {@link reqSerializer} scrubs credential headers before they
 *      reach a log line, backed by pino `redact` paths as defense in depth. A
 *      bearer token must never appear in the output.
 *   3. C8 tagging — {@link classifyErrorCode} maps any thrown error to its
 *      CONTRACTS §C8 code for `errorCode`-tagged error logs.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

/** The request-id header we read on the way in and echo on the way out. */
export const REQUEST_ID_HEADER = 'x-request-id';

/** Only alphanumerics, dot, dash, underscore — anything else is treated as hostile. */
const SAFE_REQUEST_ID = /^[\w.-]{1,200}$/;

/**
 * Generate (or adopt) a request id. Fastify calls this with the raw Node request
 * only when `requestIdHeader` did not already supply one, but it re-reads the
 * header itself so it is correct as a standalone `genReqId` too. A malformed or
 * hostile inbound id (control chars, absurd length) is discarded in favor of a
 * fresh UUID so a caller cannot forge log lines through the header.
 */
export function genRequestId(req: { headers: IncomingHttpHeaders }): string {
  const raw = req.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (typeof candidate === 'string' && SAFE_REQUEST_ID.test(candidate.trim())) {
    return candidate.trim();
  }
  return randomUUID();
}

// --- Serializers ------------------------------------------------------------

/** The request fields the serializer reads (FastifyRequest is assignable to this). */
export interface SerializableRequest {
  id: string;
  method: string;
  url: string;
  ip: string;
  headers: Record<string, unknown>;
}

// A `type` (not `interface`) so it carries the implicit index signature that
// Fastify's `serializers.req` return slot (`{ ...; [key: string]: unknown }`)
// requires under exactOptionalPropertyTypes.
export type SerializedRequest = {
  id: string;
  method: string;
  url: string;
  remoteAddress: string;
  headers: Record<string, unknown>;
};

/** Serialize a request for logging with credential headers redacted. */
export function reqSerializer(req: SerializableRequest): SerializedRequest {
  return {
    id: req.id,
    method: req.method,
    url: req.url,
    remoteAddress: req.ip,
    headers: redactHeaders(req.headers),
  };
}

export interface SerializableReply {
  statusCode: number;
}

/** Serialize a reply — status code only; response headers are never logged. */
export function resSerializer(res: SerializableReply): { statusCode: number } {
  return { statusCode: res.statusCode };
}

/** The error fields the serializer reads (FastifyError is assignable to this). */
export interface SerializableError {
  name?: string;
  message?: string;
  stack?: string;
  code?: unknown;
  statusCode?: unknown;
  validation?: unknown;
}

// A `type` (not `interface`) for the same implicit-index-signature reason as
// SerializedRequest — it feeds Fastify's `serializers.err` return slot.
export type SerializedError = {
  type: string;
  message: string;
  stack: string;
  code: ErrorCode;
};

/**
 * Serialize an error with its C8 code attached. Only a controlled set of fields
 * is emitted — arbitrary enumerable error properties (which can carry request
 * config, headers, tokens) are deliberately NOT spread through.
 */
export function errSerializer(err: SerializableError): SerializedError {
  return {
    type: typeof err.name === 'string' && err.name.length > 0 ? err.name : 'Error',
    message: typeof err.message === 'string' ? err.message : '',
    stack: typeof err.stack === 'string' ? err.stack : '',
    code: classifyErrorCode(err),
  };
}

// --- C8 error-code classification -------------------------------------------

function statusToErrorCodeInternal(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'VALIDATION_FAILED';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 422:
      return 'SUPPRESSED';
    case 429:
      return 'RATE_LIMITED';
    case 502:
      return 'PROVIDER_ERROR';
    default:
      return 'INTERNAL';
  }
}

/**
 * Best-effort C8 code for a bare HTTP status (used when tagging a completed
 * response that has no error object). Ambiguous statuses (422, 429, 409) resolve
 * to their most common code; everything unmapped is `INTERNAL`.
 */
export function statusToErrorCode(status: number): ErrorCode {
  return statusToErrorCodeInternal(status);
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ERROR_STATUS, value);
}

/**
 * Map any thrown value to a CONTRACTS §C8 code for log tagging. Priority: an
 * explicit valid `.code`, then zod/Fastify validation shapes, then a fallback by
 * `.statusCode`, else `INTERNAL`. Never throws.
 */
export function classifyErrorCode(err: unknown): ErrorCode {
  if (typeof err !== 'object' || err === null) return 'INTERNAL';
  const e = err as {
    code?: unknown;
    name?: unknown;
    statusCode?: unknown;
    validation?: unknown;
  };
  if (isErrorCode(e.code)) return e.code;
  if (e.name === 'ZodError') return 'VALIDATION_FAILED';
  if (e.validation !== undefined && e.validation !== null) return 'VALIDATION_FAILED';
  if (e.code === 'FST_ERR_VALIDATION') return 'VALIDATION_FAILED';
  if (typeof e.statusCode === 'number') return statusToErrorCodeInternal(e.statusCode);
  return 'INTERNAL';
}

// --- Logger options factory -------------------------------------------------

export interface BuildLoggerOptionsInput {
  /** pino level; default `info`. */
  level?: string;
  /** Logger name stamped on every line (scraper friendliness); default `switchboard-api`. */
  name?: string;
  /** Test/prod destination stream. Omit to use pino's default stdout. */
  stream?: { write(msg: string): void };
}

export interface SwitchboardLoggerOptions {
  level: string;
  name: string;
  serializers: {
    req: (req: SerializableRequest) => SerializedRequest;
    res: (res: SerializableReply) => { statusCode: number };
    err: (err: SerializableError) => SerializedError;
  };
  redact: { paths: string[]; censor: string };
  stream?: { write(msg: string): void };
}

/**
 * Defense-in-depth redact paths. The req serializer already scrubs
 * `req.headers`, but these catch credential material logged directly (e.g.
 * `log.info({ authorization })`) or via a bypassed serializer. pino censors the
 * value at each path in place.
 */
const REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.headers["proxy-authorization"]',
  'req.headers["x-api-key"]',
  'headers.authorization',
  'headers.cookie',
  'authorization',
  'cookie',
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'clientSecret',
  'apiKey',
  'oauthTokens',
];

/**
 * Build the pino options object for `Fastify({ logger })`. The return type is a
 * structural subset of `FastifyLoggerOptions & PinoLoggerOptions` (verified by
 * the http-observability integration test, which feeds it to a real Fastify).
 */
export function buildLoggerOptions(input: BuildLoggerOptionsInput = {}): SwitchboardLoggerOptions {
  return {
    level: input.level ?? 'info',
    name: input.name ?? 'switchboard-api',
    serializers: { req: reqSerializer, res: resSerializer, err: errSerializer },
    redact: { paths: [...REDACT_PATHS], censor: REDACTED },
    ...(input.stream !== undefined ? { stream: input.stream } : {}),
  };
}

export interface BuildLogControllerInput {
  /** Suppress Fastify's built-in incoming/completed logs; default `true`. */
  disableRequestLogging?: boolean;
  /** Log field label for the request id; default Fastify's `reqId`. */
  requestIdLogLabel?: string;
}

/**
 * Build the Fastify `logController` that turns OFF the framework's automatic
 * per-request logging, so the http-observability plugin's sampled completion log
 * is the single source of request logs. Passed as `Fastify({ logController })` —
 * the non-deprecated replacement for the top-level `disableRequestLogging` flag
 * (removed in fastify@6).
 */
export function buildLogController(input: BuildLogControllerInput = {}): LogController {
  return new LogController({
    disableRequestLogging: input.disableRequestLogging ?? true,
    ...(input.requestIdLogLabel !== undefined
      ? { requestIdLogLabel: input.requestIdLogLabel }
      : {}),
  });
}
