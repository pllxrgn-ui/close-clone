import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { KeyboardProvider } from '../../../keyboard/index.ts';

/*
 * Test seams for the leads feature.
 *
 * jsdom has no layout engine and no ResizeObserver, so @tanstack/react-virtual
 * measures a zero-height viewport and windows nothing. `installVirtualizerEnv`
 * gives the scroll port a real height (and a no-op ResizeObserver + scrollTo) so
 * the virtualizer produces a real, small window over a large row count — exactly
 * what the 5k windowing assertion needs. It uses plain save/restore (not vi
 * mocks) so vitest's per-test `restoreMocks` can't tear it down mid-file.
 */

interface VirtualizerEnvOptions {
  height?: number;
  width?: number;
}

export function installVirtualizerEnv({
  height = 640,
  width = 900,
}: VirtualizerEnvOptions = {}): () => void {
  const proto = Element.prototype;
  const savedRect = proto.getBoundingClientRect;
  const hadScrollTo = 'scrollTo' in proto;
  const scrollHost = proto as { scrollTo?: (options?: ScrollToOptions) => void };
  const savedScrollTo = scrollHost.scrollTo;
  const roHost = globalThis as { ResizeObserver?: typeof ResizeObserver };
  const savedRO = roHost.ResizeObserver;

  // react-virtual v3 gets the viewport size from the ResizeObserver callback, not
  // a synchronous rect read — so the mock must actually deliver an entry (with the
  // stubbed rect) when a scroll element is observed, or the virtualizer windows 0.
  class MockResizeObserver implements ResizeObserver {
    private readonly cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe(target: Element): void {
      const rect = target.getBoundingClientRect();
      const size = { inlineSize: rect.width, blockSize: rect.height };
      const entry = {
        target,
        contentRect: rect,
        borderBoxSize: [size],
        contentBoxSize: [size],
        devicePixelContentBoxSize: [size],
      } as unknown as ResizeObserverEntry;
      this.cb([entry], this);
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  roHost.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

  proto.getBoundingClientRect = function (this: Element): DOMRect {
    const isScroller =
      this instanceof HTMLElement && this.getAttribute('data-virtual-scroll') === 'true';
    const h = isScroller ? height : 36;
    return {
      width,
      height: h,
      top: 0,
      left: 0,
      right: width,
      bottom: h,
      x: 0,
      y: 0,
      toJSON() {
        return {};
      },
    };
  };
  scrollHost.scrollTo = () => {};

  return () => {
    proto.getBoundingClientRect = savedRect;
    if (hadScrollTo && savedScrollTo) scrollHost.scrollTo = savedScrollTo;
    else delete scrollHost.scrollTo;
    if (savedRO) roHost.ResizeObserver = savedRO;
    else delete roHost.ResizeObserver;
  };
}

/** Render a component under the keyboard registry (required by useListNav). */
export function renderWithKeyboard(ui: ReactElement): RenderResult {
  return render(<KeyboardProvider>{ui}</KeyboardProvider>);
}
