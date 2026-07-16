import type { HealthThresholds } from './health.ts';

/**
 * Threshold alerting (Task 5e, ARCHITECTURE §8: "queue-depth + sync-lag alerts
 * via structured logs → whatever the company scrapes"). This module owns the
 * on-the-wire contract for those alerts: a log line carrying a top-level
 * `event: "alert"` discriminator plus a typed `alert` object. The scraper keys
 * on `event === "alert"`; do not rename those fields without updating §8.
 *
 * The evaluation is a pure function; emission and the periodic monitor are thin
 * wrappers so both firing and quiet paths are trivially testable. Thresholds are
 * injected (shared shape with the /healthz degrade thresholds).
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export type AlertKind = 'queue_depth' | 'sync_lag';

export interface AlertSnapshot {
  queueDepth: number | null;
  syncLagSeconds: number | null;
}

export interface AlertEvent {
  kind: AlertKind;
  value: number;
  threshold: number;
  severity: 'warning';
  message: string;
}

/** Pure: which thresholds does this snapshot breach? Strictly-greater-than. */
export function evaluateAlerts(
  snapshot: AlertSnapshot,
  thresholds: HealthThresholds,
): AlertEvent[] {
  const events: AlertEvent[] = [];
  if (
    thresholds.queueDepth !== undefined &&
    snapshot.queueDepth !== null &&
    snapshot.queueDepth > thresholds.queueDepth
  ) {
    events.push({
      kind: 'queue_depth',
      value: snapshot.queueDepth,
      threshold: thresholds.queueDepth,
      severity: 'warning',
      message: `queue depth ${snapshot.queueDepth} exceeds threshold ${thresholds.queueDepth}`,
    });
  }
  if (
    thresholds.syncLagSeconds !== undefined &&
    snapshot.syncLagSeconds !== null &&
    snapshot.syncLagSeconds > thresholds.syncLagSeconds
  ) {
    events.push({
      kind: 'sync_lag',
      value: snapshot.syncLagSeconds,
      threshold: thresholds.syncLagSeconds,
      severity: 'warning',
      message: `email sync lag ${snapshot.syncLagSeconds}s exceeds threshold ${thresholds.syncLagSeconds}s`,
    });
  }
  return events;
}

/** The minimal logger surface the emitter needs (pino/Fastify logger satisfies it). */
export interface AlertLogger {
  warn(obj: object, msg?: string): void;
}

/**
 * Evaluate + emit. Each breach becomes one `{ event: "alert", alert }` warn
 * line. Returns the events for callers/tests. Quiet when nothing breaches.
 */
export function emitAlerts(
  logger: AlertLogger,
  snapshot: AlertSnapshot,
  thresholds: HealthThresholds,
): AlertEvent[] {
  const events = evaluateAlerts(snapshot, thresholds);
  for (const event of events) {
    logger.warn({ event: 'alert', alert: event }, event.message);
  }
  return events;
}

const DEFAULT_INTERVAL_MS = 30_000;

export interface AlertMonitorDeps {
  /** Gather the current snapshot (composition root wires this to the health probes). */
  sample: () => Promise<AlertSnapshot> | AlertSnapshot;
  thresholds: HealthThresholds;
  logger: AlertLogger;
  /** Poll interval in ms; default 30s. */
  intervalMs?: number;
  /** Called if sampling throws (kept off the timer path). */
  onError?: (err: unknown) => void;
}

/**
 * Periodic alert monitor for the runtime (MOCK_MODE + production). `start`/`stop`
 * manage a self-unref'ing interval; `runOnce` is the deterministic unit the
 * tests drive. Sampling errors are swallowed so a transient probe failure never
 * crashes the monitor.
 */
export class AlertMonitor {
  private readonly deps: AlertMonitorDeps;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: AlertMonitorDeps) {
    this.deps = deps;
  }

  async runOnce(): Promise<AlertEvent[]> {
    try {
      const snapshot = await this.deps.sample();
      return emitAlerts(this.deps.logger, snapshot, this.deps.thresholds);
    } catch (err) {
      this.deps.onError?.(err);
      return [];
    }
  }

  start(): void {
    if (this.timer !== undefined) return; // idempotent
    const intervalMs = this.deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
