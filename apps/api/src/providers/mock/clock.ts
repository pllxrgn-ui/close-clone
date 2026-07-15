/**
 * Deterministic time + id sources for the mock providers (CONTRACTS §C9: every
 * module works under MOCK_MODE=1; task 2a: no `Date.now()`/`Math.random()` in
 * mock behaviour — clocks and ids are injectable).
 *
 * These are test/dev infrastructure used by the composition root's mock branch.
 * Real adapters read wall-clock time and provider-assigned ids directly.
 */

/** A clock the mock reads instead of `Date.now()`. */
export interface Clock {
  now(): Date;
}

/**
 * A hand-advanced clock. Starts at a fixed instant and only moves when a test
 * calls `advance`/`set`, so provider output (token expiry, `sentAt`, watch
 * expiry) is fully deterministic.
 */
export class ManualClock implements Clock {
  private ms: number;

  constructor(start: Date | string | number = '2026-01-01T00:00:00.000Z') {
    this.ms = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.ms);
  }

  /** Advance the clock by `deltaMs` milliseconds (must be non-negative). */
  advance(deltaMs: number): void {
    if (deltaMs < 0) throw new Error('ManualClock cannot move backwards');
    this.ms += deltaMs;
  }

  /** Jump the clock to an absolute instant. */
  set(instant: Date | string | number): void {
    this.ms = new Date(instant).getTime();
  }
}

/** A monotonic id source the mock uses instead of `Math.random()`/uuid. */
export interface IdSource {
  /** Next id for the given kind, e.g. `next('msg') → 'msg-1'`. */
  next(kind: string): string;
}

/** Per-kind incrementing counter. Deterministic across a run. */
export class SequentialIds implements IdSource {
  private counters = new Map<string, number>();

  next(kind: string): string {
    const n = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, n);
    return `${kind}-${n}`;
  }
}
