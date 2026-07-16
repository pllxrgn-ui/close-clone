import { useEffect, useState } from 'react';

/*
 * Tracks the `prefers-reduced-motion` media query. Motion is otherwise handled
 * in CSS (transitions gated by the media query); this hook is for the few places
 * that must also drop JS-driven movement, and it drives a `data-reduced-motion`
 * hook on the surface that tests assert against. Feature-detects matchMedia so it
 * is inert under SSR / bare jsdom.
 */

const QUERY = '(prefers-reduced-motion: reduce)';

function readMatch(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(QUERY).matches;
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(readMatch);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(QUERY);
    const onChange = (): void => setReduced(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return reduced;
}
