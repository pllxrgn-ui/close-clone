import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  IGNITION_SESSION_KEY,
  decideIgnition,
  hasIgnitedThisSession,
  markIgnitedThisSession,
  prefersReducedMotion,
  useIgnition,
} from './useIgnition.ts';

/** Point window.matchMedia at a fixed answer for the reduced-motion query. */
function stubReducedMotion(matches: boolean): void {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string): MediaQueryList => ({
    matches: query.includes('prefers-reduced-motion') ? matches : false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  sessionStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('decideIgnition (pure)', () => {
  test('a fresh, motion-allowed visit ignites', () => {
    expect(decideIgnition(false, false)).toBe('igniting');
  });

  test('reduced motion collapses to lit', () => {
    expect(decideIgnition(true, false)).toBe('lit');
  });

  test('an already-ignited session stays lit', () => {
    expect(decideIgnition(false, true)).toBe('lit');
  });

  test('reduced motion AND already-ignited is lit', () => {
    expect(decideIgnition(true, true)).toBe('lit');
  });
});

describe('session flag', () => {
  test('defaults to not-yet-ignited', () => {
    expect(hasIgnitedThisSession()).toBe(false);
  });

  test('markIgnited persists across reads', () => {
    markIgnitedThisSession();
    expect(sessionStorage.getItem(IGNITION_SESSION_KEY)).toBe('1');
    expect(hasIgnitedThisSession()).toBe(true);
  });

  test('a throwing sessionStorage is swallowed, never crashes', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    expect(hasIgnitedThisSession()).toBe(false);
    expect(() => markIgnitedThisSession()).not.toThrow();
  });
});

describe('prefersReducedMotion', () => {
  test('true when the media query matches', () => {
    stubReducedMotion(true);
    expect(prefersReducedMotion()).toBe(true);
  });

  test('false when it does not match', () => {
    stubReducedMotion(false);
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe('useIgnition', () => {
  test('ignites on the first visit and burns the session flag', () => {
    stubReducedMotion(false);
    const { result } = renderHook(() => useIgnition());
    expect(result.current).toBe('igniting');
    // Effect ran → any later mount this session must be lit.
    expect(hasIgnitedThisSession()).toBe(true);
  });

  test('a second mount in the same session does not re-ignite', () => {
    stubReducedMotion(false);
    renderHook(() => useIgnition());
    const second = renderHook(() => useIgnition());
    expect(second.result.current).toBe('lit');
  });

  test('reduced motion is lit and never burns the flag', () => {
    stubReducedMotion(true);
    const { result } = renderHook(() => useIgnition());
    expect(result.current).toBe('lit');
    expect(hasIgnitedThisSession()).toBe(false);
  });
});
