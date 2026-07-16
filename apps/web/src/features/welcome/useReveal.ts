import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { prefersReducedMotion } from './useIgnition.ts';

/*
 * Scroll-into-view reveal for the three feature acts (and only those). Each act
 * rises 8px and fades in once, the first time it crosses the viewport. This is
 * NOT choreography — it is a single, independent per-element entrance.
 *
 * Robust by design — the content must never get stuck hidden:
 *   - reduced motion or no IntersectionObserver → revealed from the start;
 *   - already in view at mount → revealed immediately (no wait on a callback);
 *   - IntersectionObserver drives the on-scroll reveal (the requested path);
 *   - a passive scroll listener is a belt-and-suspenders fallback for any
 *     environment where IO is present but its callbacks never arrive.
 * All listeners are torn down the moment the element reveals.
 */
export interface RevealResult<T extends HTMLElement> {
  ref: RefObject<T | null>;
  revealed: boolean;
}

export function useReveal<T extends HTMLElement = HTMLElement>(): RevealResult<T> {
  const ref = useRef<T | null>(null);
  const [revealed, setRevealed] = useState<boolean>(
    () => prefersReducedMotion() || typeof IntersectionObserver === 'undefined',
  );

  useEffect(() => {
    if (revealed) return;
    const node = ref.current;
    if (!node) {
      setRevealed(true);
      return;
    }

    const inView = (): boolean => {
      const rect = node.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight;
      return rect.top < vh * 0.9 && rect.bottom > 0;
    };

    if (inView()) {
      setRevealed(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setRevealed(true);
      },
      { threshold: 0.2, rootMargin: '0px 0px -10% 0px' },
    );
    observer.observe(node);

    const onScroll = (): void => {
      if (inView()) setRevealed(true);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [revealed]);

  return { ref, revealed };
}
