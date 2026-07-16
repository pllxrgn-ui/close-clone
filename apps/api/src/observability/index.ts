/**
 * Observability + operational hardening (Task 5e). Every export here is a
 * factory/plugin the composition root wires — nothing self-registers, nothing
 * reads `process.env` at import time (except the health `version` fallback). See
 * the task report's routeWiring for the exact Fastify/server assembly.
 */

// Redaction (shared by the serializers, error sink, and alerts).
export { REDACTED, isSensitiveField, redactDeep, redactHeaders } from './redaction.ts';

// Structured logging config for Fastify's pino.
export {
  REQUEST_ID_HEADER,
  buildLogController,
  buildLoggerOptions,
  classifyErrorCode,
  errSerializer,
  genRequestId,
  reqSerializer,
  resSerializer,
  statusToErrorCode,
} from './logging.ts';
export type {
  BuildLogControllerInput,
  BuildLoggerOptionsInput,
  SerializableError,
  SerializableReply,
  SerializableRequest,
  SerializedError,
  SerializedRequest,
  SwitchboardLoggerOptions,
} from './logging.ts';

// HTTP observability plugin (request-id out, sampled logs, error tagging + capture).
export { registerHttpObservability } from './http-observability.ts';
export type { HttpObservabilityDeps } from './http-observability.ts';

// Error-tracking adapter.
export {
  createConsoleErrorSink,
  createDsnErrorSink,
  createErrorSinkFromConfig,
  createNoopErrorSink,
  parseSentryDsn,
} from './error-sink.ts';
export type {
  DsnErrorSinkOptions,
  ErrorContext,
  ErrorSink,
  ErrorSinkConfig,
  ErrorSinkTransport,
  MinimalErrorLogger,
  ParsedDsn,
} from './error-sink.ts';

// /healthz plugin + checks.
export {
  checkDatabase,
  checkQueueDepth,
  checkSyncLag,
  gatherHealth,
  registerHealthz,
} from './health.ts';
export type {
  CheckStatus,
  DatabaseCheck,
  DbCheckOptions,
  HealthDeps,
  HealthReport,
  HealthThresholds,
  QueueCheck,
  QueueDepthProbe,
  SyncLagCheck,
  SyncLagCheckOptions,
} from './health.ts';

// Threshold alerting.
export { AlertMonitor, emitAlerts, evaluateAlerts } from './alerts.ts';
export type {
  AlertEvent,
  AlertKind,
  AlertLogger,
  AlertMonitorDeps,
  AlertSnapshot,
} from './alerts.ts';

// Security headers plugin.
export { registerSecurityHeaders } from './security-headers.ts';
export type { SecurityHeadersOptions } from './security-headers.ts';

// Graceful shutdown helper.
export { createGracefulShutdown, runShutdown } from './shutdown.ts';
export type {
  Closable,
  GracefulShutdown,
  GracefulShutdownDeps,
  RunShutdownOptions,
  ShutdownLogger,
  ShutdownResult,
  ShutdownStep,
  SignalRegistrar,
} from './shutdown.ts';
