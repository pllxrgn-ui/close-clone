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

// One MSW node server shared by every test; the handler set is the same one the
// browser worker uses. Unhandled requests fail loudly so gaps surface as errors.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
