import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { JSX } from 'react';
import { cleanup, render } from '@testing-library/react';

const { gsapFrom, gsapToArray, scrollTriggerDisable, scrollTriggerEnable, useGSAPConfig } =
  vi.hoisted(() => ({
    gsapFrom: vi.fn(),
    gsapToArray: vi.fn(),
    scrollTriggerDisable: vi.fn(),
    scrollTriggerEnable: vi.fn(),
    useGSAPConfig: vi.fn(),
  }));

vi.mock('gsap', () => ({
  default: {
    registerPlugin: vi.fn(),
    from: gsapFrom,
    utils: { toArray: gsapToArray },
  },
}));

vi.mock('gsap/ScrollTrigger', () => ({
  ScrollTrigger: { disable: scrollTriggerDisable, enable: scrollTriggerEnable },
}));

vi.mock('@gsap/react', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    useGSAP(callback: () => void | (() => void), config: unknown): void {
      useGSAPConfig(config);
      React.useLayoutEffect(callback, []);
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

function ProbeSet({ count }: { count: number }): JSX.Element {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <Probe key={index} />
      ))}
    </>
  );
}

beforeEach(() => {
  gsapFrom.mockReset();
  gsapToArray.mockReset();
  scrollTriggerDisable.mockReset();
  scrollTriggerEnable.mockReset();
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
    expect(scrollTriggerEnable).not.toHaveBeenCalled();
    expect(scrollTriggerDisable).toHaveBeenCalledTimes(1);
    expect(getByTestId('probe')).toBeVisible();
  });

  test('keeps the scheduler active until the last reveal scope unmounts', () => {
    stubReducedMotion(false);
    const { rerender, unmount } = render(<ProbeSet count={2} />);

    expect(scrollTriggerEnable).toHaveBeenCalledTimes(1);
    expect(gsapFrom).toHaveBeenCalledTimes(2);
    rerender(<ProbeSet count={1} />);
    expect(scrollTriggerDisable).not.toHaveBeenCalled();
    unmount();
    expect(scrollTriggerDisable).toHaveBeenCalledTimes(1);
  });

  test('re-enables the scheduler before creating a trigger on re-entry', () => {
    stubReducedMotion(false);
    const first = render(<Probe />);
    first.unmount();
    render(<Probe />);

    expect(scrollTriggerEnable).toHaveBeenCalledTimes(2);
    expect(scrollTriggerDisable).toHaveBeenCalledTimes(1);
    expect(scrollTriggerEnable.mock.invocationCallOrder[1]).toBeLessThan(
      gsapFrom.mock.invocationCallOrder[1]!,
    );
  });
});
