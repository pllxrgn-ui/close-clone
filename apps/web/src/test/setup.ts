import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from '../mocks/server.ts';

/*
 * jsdom does not implement matchMedia; the theme + reduced-motion code paths
 * feature-detect it, but a stub lets the "system" theme path exercise its
 * listener wiring in tests.
 */
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  });
}

/*
 * Node 24 / undici v7 brand-checks RequestInit.signal against ITS realm's
 * AbortSignal. Vitest's jsdom sandbox injects Node's fetch but jsdom's own
 * AbortController, so every abortable fetch (react-query threads its signal
 * into each queryFn) rejects with "Expected signal to be an instance of
 * AbortSignal" — 70 tests red on CI (Node 24) while Node 22's undici accepted
 * the foreign realm. The sandbox cannot mint undici-realm signals (vm.runInThisContext
 * still evaluates in the sandbox context), so the shim retries exactly once
 * WITHOUT the signal when that specific TypeError surfaces. Test-env only;
 * browser code is untouched, and the Node 22 path never hits the retry.
 */
function installSignalRealmRelay(): void {
  const current = globalThis.fetch as typeof fetch & { __signalRelay?: true };
  if (typeof current !== 'function' || current.__signalRelay) return;
  const inner = current.bind(globalThis);
  const wrapped = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (!init?.signal) return inner(input, init);
    return inner(input, init).catch((err: unknown) => {
      // The vitest sandbox has no handle on undici's realm, so the signal cannot
      // be re-homed — instead, on exactly this error, retry once without it. The
      // request becomes non-abortable (fine for unit tests: MSW answers
      // synchronously and react-query discards stale results itself).
      if (err instanceof TypeError && /Expected signal/.test(err.message)) {
        const { signal: _dropped, ...rest } = init;
        return inner(input, rest);
      }
      throw err;
    });
  }) as typeof fetch & { __signalRelay?: true };
  wrapped.__signalRelay = true;
  globalThis.fetch = wrapped;
}

// One MSW node server shared by every test; the handler set is the same one the
// browser worker uses. Unhandled requests fail loudly so gaps surface as errors.
// The signal relay must wrap the fetch MSW installs, so it goes on AFTER listen().
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
  installSignalRealmRelay();
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
