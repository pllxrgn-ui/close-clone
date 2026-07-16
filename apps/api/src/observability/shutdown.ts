/**
 * Graceful shutdown (Task 5e, ARCHITECTURE §8). The production entrypoint wires
 * this so a SIGTERM/SIGINT drains the HTTP server (stop accepting, let in-flight
 * requests finish) and THEN closes the stateful resources — the pg pool and the
 * queue driver — before the process exits.
 *
 * Split into a pure `runShutdown` (an ordered step runner with a hard deadline)
 * and `createGracefulShutdown` (binds Fastify + resources, adds idempotency and
 * signal wiring). Both are exported so the composition root can compose them and
 * the tests can drive them without real signals.
 *
 * Design choices:
 *   - resources are closed even if an earlier one fails — a queue-close error
 *     must not leak the pg pool.
 *   - a hard timeout forces completion (`forced: true`) so a wedged close cannot
 *     hang the process forever; the caller decides the exit code.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export interface ShutdownStep {
  name: string;
  run: () => Promise<void> | void;
}

export interface ShutdownLogger {
  info(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface ShutdownResult {
  /** True when every step completed without error, within the deadline. */
  ok: boolean;
  /** True when the deadline fired before the steps finished. */
  forced: boolean;
  /** Names of steps that completed successfully, in order. */
  completed: string[];
  /** The first step that threw, if any. */
  failed?: { step: string; error: string };
}

export interface RunShutdownOptions {
  steps: ShutdownStep[];
  timeoutMs?: number;
  logger?: ShutdownLogger;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run `steps` in order (each awaited), collecting completions and the first
 * failure, bounded by `timeoutMs`. Never throws.
 */
export async function runShutdown(options: RunShutdownOptions): Promise<ShutdownResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const completed: string[] = [];
  let failed: { step: string; error: string } | undefined;
  let timedOut = false;

  const stepsPromise = (async (): Promise<void> => {
    for (const step of options.steps) {
      if (timedOut) return; // deadline passed — stop starting new steps
      try {
        await step.run();
        completed.push(step.name);
      } catch (err) {
        if (failed === undefined) failed = { step: step.name, error: errorMessage(err) };
        options.logger?.error({ step: step.name, err }, 'shutdown step failed');
      }
    }
  })();

  const timeoutPromise = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    void stepsPromise.finally(() => clearTimeout(timer));
  });

  await Promise.race([stepsPromise, timeoutPromise]);

  const ok = !timedOut && failed === undefined;
  return { ok, forced: timedOut, completed, ...(failed !== undefined ? { failed } : {}) };
}

export interface Closable {
  name: string;
  close: () => Promise<void> | void;
}

export interface SignalRegistrar {
  once(signal: string, handler: () => void): void;
}

export interface GracefulShutdownDeps {
  /** The Fastify server (or anything with an async `close`) to drain first. */
  app: { close: () => Promise<void> };
  /** Stateful resources to close after draining, in order (e.g. pg, queue). */
  resources?: Closable[];
  logger?: ShutdownLogger;
  timeoutMs?: number;
  /** Signal registrar; defaults to `process`. Injected in tests. */
  signals?: SignalRegistrar;
  /** Exit hook; defaults to `process.exit`. Injected in tests. */
  onExit?: (code: number) => void;
}

export interface GracefulShutdown {
  /** Idempotent — repeat calls return the in-flight/settled result. */
  shutdown(reason?: string): Promise<ShutdownResult>;
  /** Wire signal handlers that shut down then exit (0 clean / 1 on failure). */
  install(signalNames?: string[]): void;
}

/** Bind Fastify + resources into an idempotent, signal-wireable shutdown. */
export function createGracefulShutdown(deps: GracefulShutdownDeps): GracefulShutdown {
  let inFlight: Promise<ShutdownResult> | undefined;

  const shutdown = (reason = 'shutdown'): Promise<ShutdownResult> => {
    if (inFlight !== undefined) return inFlight;
    deps.logger?.info({ reason }, 'graceful shutdown starting');

    const steps: ShutdownStep[] = [
      { name: 'http', run: () => deps.app.close() },
      ...(deps.resources ?? []).map((r) => ({ name: r.name, run: r.close })),
    ];

    inFlight = runShutdown({
      steps,
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
      ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
    }).then((result) => {
      deps.logger?.info({ result }, 'graceful shutdown complete');
      return result;
    });
    return inFlight;
  };

  const install = (signalNames: string[] = ['SIGINT', 'SIGTERM']): void => {
    const registrar: SignalRegistrar = deps.signals ?? {
      once: (signal, handler): void => {
        process.once(signal as NodeJS.Signals, handler);
      },
    };
    const exit = deps.onExit ?? ((code: number): void => process.exit(code));
    for (const signal of signalNames) {
      registrar.once(signal, () => {
        void shutdown(signal).then((result) => exit(result.ok ? 0 : 1));
      });
    }
  };

  return { shutdown, install };
}
