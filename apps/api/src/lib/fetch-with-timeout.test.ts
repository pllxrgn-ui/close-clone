import { afterEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_FETCH_TIMEOUT_MS, fetchWithTimeout } from './fetch-with-timeout.ts';

describe('fetchWithTimeout', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
  });

  test('passes the url + init through and returns the response on success', async () => {
    const seen: { url: string; init: RequestInit | undefined } = { url: '', init: undefined };
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen.url = url;
      seen.init = init;
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const res = await fetchWithTimeout('https://x.test/y', { method: 'POST' }, 1000);
    expect(res.status).toBe(200);
    expect(seen.url).toBe('https://x.test/y');
    expect(seen.init?.method).toBe('POST');
    expect(seen.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test('aborts the underlying fetch when the timeout elapses', async () => {
    // fetch resolves only when its signal aborts (models a hung upstream socket).
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject((init.signal as AbortSignal).reason ?? new Error('aborted'));
        });
      });
    }) as typeof fetch;

    await expect(fetchWithTimeout('https://slow.test', {}, 5)).rejects.toMatchObject({
      name: 'TimeoutError',
    });
  });

  test('preserves caller cancellation while adding the timeout', async () => {
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    const caller = new AbortController();

    const pending = fetchWithTimeout('https://slow.test', { signal: caller.signal }, 100);
    caller.abort(new Error('caller cancelled'));

    await expect(pending).rejects.toThrow('caller cancelled');
  });

  test('default timeout is exported and generous', () => {
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
  });
});
