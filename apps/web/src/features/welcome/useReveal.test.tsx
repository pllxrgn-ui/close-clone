import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { JSX } from 'react';
import { cleanup, render } from '@testing-library/react';

const { gsapFrom, gsapToArray, useGSAPConfig } = vi.hoisted(() => ({
  gsapFrom: vi.fn(),
  gsapToArray: vi.fn(),
  useGSAPConfig: vi.fn(),
}));

vi.mock('gsap', () => ({
  default: {
    registerPlugin: vi.fn(),
    from: gsapFrom,
    utils: { toArray: gsapToArray },
  },
}));

vi.mock('gsap/ScrollTrigger', () => ({ ScrollTrigger: {} }));

vi.mock('@gsap/react', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    useGSAP(callback: () => void, config: unknown): void {
      useGSAPConfig(config);
      React.useLayoutEffect(() => {
        callback();
      }, []);
    },
  };
});

import { useReveal } from './useReveal.ts';

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

function Probe({ itemSelector }: { itemSelector?: string }): JSX.Element {
  const ref = useReveal<HTMLElement>(itemSelector === undefined ? {} : { itemSelector });
  return (
    <section ref={ref} data-testid="probe">
      <div data-reveal-item="one" />
      <div data-reveal-item="two" />
    </section>
  );
}

beforeEach(() => {
  gsapFrom.mockReset();
  gsapToArray.mockReset();
  useGSAPConfig.mockReset();
  gsapToArray.mockImplementation((selector: string, scope: HTMLElement) => [
    ...scope.querySelectorAll<HTMLElement>(selector),
  ]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useReveal', () => {
  test('creates one scoped ScrollTrigger reveal for a section', () => {
    stubReducedMotion(false);
    const { getByTestId } = render(<Probe />);
    const section = getByTestId('probe');

    expect(useGSAPConfig).toHaveBeenCalledWith(expect.objectContaining({ revertOnUpdate: true }));
    expect(gsapFrom).toHaveBeenCalledWith([section], {
      opacity: 0,
      y: 12,
      duration: 0.48,
      ease: 'power3.out',
      stagger: 0,
      clearProps: 'transform,opacity',
      scrollTrigger: {
        trigger: expect.any(HTMLElement),
        start: 'top 82%',
        once: true,
      },
    });
  });

  test('reveals selected items with a stagger', () => {
    stubReducedMotion(false);
    const { getByTestId } = render(<Probe itemSelector="[data-reveal-item]" />);
    const section = getByTestId('probe');
    const items = [...section.querySelectorAll<HTMLElement>('[data-reveal-item]')];

    expect(gsapToArray).toHaveBeenCalledWith('[data-reveal-item]', section);
    expect(gsapFrom).toHaveBeenCalledWith(items, expect.objectContaining({ stagger: 0.08 }));
  });

  test('leaves content visible without a tween under reduced motion', () => {
    stubReducedMotion(true);
    const { getByTestId } = render(<Probe />);

    expect(gsapFrom).not.toHaveBeenCalled();
    expect(getByTestId('probe')).toBeVisible();
  });
});
