import { afterEach, describe, expect, test, vi } from 'vitest';

import { AlertMonitor, emitAlerts, evaluateAlerts } from './alerts.ts';

/**
 * Task 5e — threshold alerting. Queue-depth and sync-lag breaches emit a
 * structured `alert` log line (the company scraper's contract, ARCHITECTURE §8).
 * Both firing and quiet paths are proven; thresholds are injectable.
 */

describe('evaluateAlerts', () => {
  test('is quiet when both metrics are under threshold', () => {
    const events = evaluateAlerts(
      { queueDepth: 10, syncLagSeconds: 30 },
      { queueDepth: 100, syncLagSeconds: 600 },
    );
    expect(events).toEqual([]);
  });

  test('fires queue-depth when over threshold', () => {
    const events = evaluateAlerts(
      { queueDepth: 250, syncLagSeconds: 30 },
      { queueDepth: 100, syncLagSeconds: 600 },
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('queue_depth');
    expect(events[0]?.value).toBe(250);
    expect(events[0]?.threshold).toBe(100);
  });

  test('fires both when both breach', () => {
    const events = evaluateAlerts(
      { queueDepth: 250, syncLagSeconds: 4000 },
      { queueDepth: 100, syncLagSeconds: 600 },
    );
    expect(events.map((e) => e.kind).sort()).toEqual(['queue_depth', 'sync_lag']);
  });

  test('never fires on a null metric or an unset threshold', () => {
    expect(evaluateAlerts({ queueDepth: null, syncLagSeconds: null }, {})).toEqual([]);
    expect(
      evaluateAlerts({ queueDepth: 9999, syncLagSeconds: 9999 }, {}), // no thresholds configured
    ).toEqual([]);
  });

  test('does not fire exactly at the threshold (strictly greater)', () => {
    expect(evaluateAlerts({ queueDepth: 100, syncLagSeconds: null }, { queueDepth: 100 })).toEqual(
      [],
    );
  });
});

describe('emitAlerts', () => {
  test('emits one structured alert log line per breach', () => {
    const warn = vi.fn();
    const events = emitAlerts(
      { warn },
      { queueDepth: 250, syncLagSeconds: null },
      { queueDepth: 100 },
    );
    expect(events).toHaveLength(1);
    expect(warn).toHaveBeenCalledOnce();
    const [obj, msg] = warn.mock.calls[0] ?? [];
    expect(obj).toMatchObject({ event: 'alert', alert: { kind: 'queue_depth', value: 250 } });
    expect(typeof msg).toBe('string');
  });

  test('stays silent when nothing breaches', () => {
    const warn = vi.fn();
    const events = emitAlerts({ warn }, { queueDepth: 1, syncLagSeconds: 1 }, { queueDepth: 100 });
    expect(events).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('AlertMonitor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('runOnce samples and emits, returning the events', async () => {
    const warn = vi.fn();
    const monitor = new AlertMonitor({
      sample: () => ({ queueDepth: 500, syncLagSeconds: 0 }),
      thresholds: { queueDepth: 100 },
      logger: { warn },
    });
    const events = await monitor.runOnce();
    expect(events).toHaveLength(1);
    expect(warn).toHaveBeenCalledOnce();
  });

  test('runOnce swallows a sampler error and reports via onError', async () => {
    const onError = vi.fn();
    const monitor = new AlertMonitor({
      sample: () => {
        throw new Error('probe failed');
      },
      thresholds: { queueDepth: 100 },
      logger: { warn: vi.fn() },
      onError,
    });
    const events = await monitor.runOnce();
    expect(events).toEqual([]);
    expect(onError).toHaveBeenCalledOnce();
  });

  test('start fires runOnce on the interval; stop halts it', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const monitor = new AlertMonitor({
      sample: () => ({ queueDepth: 500, syncLagSeconds: null }),
      thresholds: { queueDepth: 100 },
      logger: { warn },
      intervalMs: 1000,
    });
    monitor.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(warn).toHaveBeenCalledTimes(2);
    monitor.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(warn).toHaveBeenCalledTimes(2); // no more after stop
  });

  test('start is idempotent and stop before start is safe', () => {
    vi.useFakeTimers();
    const monitor = new AlertMonitor({
      sample: () => ({ queueDepth: 0, syncLagSeconds: 0 }),
      thresholds: {},
      logger: { warn: vi.fn() },
      intervalMs: 1000,
    });
    expect(() => monitor.stop()).not.toThrow();
    monitor.start();
    expect(() => monitor.start()).not.toThrow();
    monitor.stop();
  });
});
