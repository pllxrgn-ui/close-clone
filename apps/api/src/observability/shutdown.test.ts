import { describe, expect, test, vi } from 'vitest';

import { createGracefulShutdown, runShutdown } from './shutdown.ts';

/**
 * Task 5e — graceful shutdown. Drains the HTTP server first, then closes pg and
 * the queue in order; is idempotent; keeps closing resources even if one fails;
 * and forces after a timeout when a close hangs.
 */

describe('runShutdown', () => {
  test('runs steps in order and reports completion', async () => {
    const order: string[] = [];
    const result = await runShutdown({
      steps: [
        { name: 'http', run: () => void order.push('http') },
        { name: 'pg', run: async () => void order.push('pg') },
        { name: 'queue', run: async () => void order.push('queue') },
      ],
    });
    expect(order).toEqual(['http', 'pg', 'queue']);
    expect(result.ok).toBe(true);
    expect(result.forced).toBe(false);
    expect(result.completed).toEqual(['http', 'pg', 'queue']);
  });

  test('keeps going when a step fails, and reports it', async () => {
    const order: string[] = [];
    const result = await runShutdown({
      steps: [
        { name: 'http', run: async () => void order.push('http') },
        {
          name: 'pg',
          run: async () => {
            order.push('pg');
            throw new Error('pg close failed');
          },
        },
        { name: 'queue', run: async () => void order.push('queue') },
      ],
    });
    expect(order).toEqual(['http', 'pg', 'queue']); // queue still closed
    expect(result.ok).toBe(false);
    expect(result.failed?.step).toBe('pg');
    expect(result.failed?.error).toContain('pg close failed');
  });

  test('forces after the timeout when a step hangs', async () => {
    const result = await runShutdown({
      steps: [
        { name: 'fast', run: async () => {} },
        { name: 'hang', run: () => new Promise<void>(() => {}) },
      ],
      timeoutMs: 20,
    });
    expect(result.forced).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.completed).toContain('fast');
  });
});

describe('createGracefulShutdown', () => {
  test('drains http before closing pg then queue, idempotently', async () => {
    const order: string[] = [];
    const pgClose = vi.fn(async () => void order.push('pg'));
    const queueClose = vi.fn(async () => void order.push('queue'));
    const gs = createGracefulShutdown({
      app: { close: async () => void order.push('http') },
      resources: [
        { name: 'pg', close: pgClose },
        { name: 'queue', close: queueClose },
      ],
    });

    const r1 = await gs.shutdown('SIGTERM');
    const r2 = await gs.shutdown('SIGTERM'); // second call must not re-run

    expect(order).toEqual(['http', 'pg', 'queue']);
    expect(pgClose).toHaveBeenCalledOnce();
    expect(queueClose).toHaveBeenCalledOnce();
    expect(r1).toBe(r2);
    expect(r1.ok).toBe(true);
  });

  test('works with no resources (drain only)', async () => {
    const closed = vi.fn(async () => {});
    const gs = createGracefulShutdown({ app: { close: closed } });
    const result = await gs.shutdown();
    expect(closed).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
  });

  test('install wires signals to shutdown + exit code', async () => {
    const handlers: Record<string, () => void> = {};
    const exits: number[] = [];
    const gs = createGracefulShutdown({
      app: { close: async () => {} },
      resources: [{ name: 'pg', close: async () => {} }],
      signals: {
        once: (signal, handler) => {
          handlers[signal] = handler;
        },
      },
      onExit: (code) => void exits.push(code),
    });

    gs.install(['SIGTERM']);
    expect(handlers['SIGTERM']).toBeDefined();

    handlers['SIGTERM']?.();
    await vi.waitFor(() => expect(exits).toEqual([0]));
  });

  test('install exits non-zero when a close fails', async () => {
    const handlers: Record<string, () => void> = {};
    const exits: number[] = [];
    const gs = createGracefulShutdown({
      app: { close: async () => {} },
      resources: [
        {
          name: 'pg',
          close: async () => {
            throw new Error('nope');
          },
        },
      ],
      signals: {
        once: (signal, handler) => {
          handlers[signal] = handler;
        },
      },
      onExit: (code) => void exits.push(code),
    });

    gs.install(['SIGINT']);
    handlers['SIGINT']?.();
    await vi.waitFor(() => expect(exits).toEqual([1]));
  });
});
