import { afterEach, describe, expect, test, vi } from 'vitest';
import type { JSX } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { useReveal } from './useReveal.ts';

/* A minimal probe that surfaces the hook's revealed flag on a real node. */
function Probe(): JSX.Element {
  const { ref, revealed } = useReveal<HTMLDivElement>();
  return <div ref={ref} data-testid="probe" data-revealed={revealed ? 'yes' : 'no'} />;
}

/** An IntersectionObserver that is present but never delivers a callback. */
class SilentObserver {
  root = null;
  rootMargin = '';
  thresholds: readonly number[] = [];
  constructor(_cb: IntersectionObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

function rect(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: 0,
    right: 100,
    width: 100,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function spyRect() {
  return vi.spyOn(Element.prototype, 'getBoundingClientRect');
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useReveal — content is never stuck hidden', () => {
  test('reveals in-view content even if IntersectionObserver never calls back', () => {
    vi.stubGlobal('IntersectionObserver', SilentObserver);
    spyRect().mockReturnValue(rect(120, 320)); // within jsdom's 768px viewport
    const { getByTestId } = render(<Probe />);
    expect(getByTestId('probe')).toHaveAttribute('data-revealed', 'yes');
  });

  test('below-view content stays hidden, then reveals via the scroll fallback', () => {
    vi.stubGlobal('IntersectionObserver', SilentObserver);
    const spy = spyRect();
    spy.mockReturnValue(rect(5000, 5200)); // far below the fold
    const { getByTestId } = render(<Probe />);
    expect(getByTestId('probe')).toHaveAttribute('data-revealed', 'no');

    spy.mockReturnValue(rect(100, 300)); // now scrolled into view
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(getByTestId('probe')).toHaveAttribute('data-revealed', 'yes');
  });

  test('reveals immediately when IntersectionObserver is unavailable', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const { getByTestId } = render(<Probe />);
    expect(getByTestId('probe')).toHaveAttribute('data-revealed', 'yes');
  });

  test('reveals immediately under reduced motion', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string): MediaQueryList => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
    const { getByTestId } = render(<Probe />);
    expect(getByTestId('probe')).toHaveAttribute('data-revealed', 'yes');
  });
});
