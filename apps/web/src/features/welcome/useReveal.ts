import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from './useIgnition.ts';

/*
 * Scroll-into-view reveal for the three feature acts (and only those). Each act
 * rises 8px and fades in once, the first time it crosses the viewport. This is
 * NOT choreography — it is a single, independent per-element entrance.
 *
 * Degrades safely: when IntersectionObserver is unavailable (jsdom, old
 * engines) or the visitor prefers reduced motion, the element starts revealed
 * so the content is always present and never depends on scrolling.
 */
export interface RevealResult<T extends HTMLElement> {
  ref: React.RefObject<T | null>;
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
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setRevealed(true);
            observer.disconnect();
            break;
          }
        }
      },
      { threshold: 0.2, rootMargin: '0px 0px -10% 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [revealed]);

  return { ref, revealed };
}
