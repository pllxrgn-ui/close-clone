import '@testing-library/jest-dom/vitest';

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
