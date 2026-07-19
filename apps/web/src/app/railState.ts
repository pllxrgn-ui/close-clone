import { useCallback, useEffect, useState } from 'react';

/*
 * Left-rail collapse state. A rep's rail preference should survive reloads and
 * route changes, so the choice is persisted to localStorage under `sb-rail`
 * (same try/catch discipline as the theme module: storage can throw in private
 * mode). Collapsing is a pointer action on a persistent preference, not a view
 * transition — there is no animation (law §4: no casual layout-property motion).
 *
 * Below RAIL_NARROW_QUERY the rail is FORCED icon-only regardless of the stored
 * preference: the expanded rail (232px) would otherwise crush `main` to an
 * unusable column on phones (audit: 143px of content at phone width). The
 * stored preference is untouched — widen the window and it comes back.
 */

export const RAIL_STORAGE_KEY = 'sb-rail';

export function readRailCollapsed(): boolean {
  try {
    return localStorage.getItem(RAIL_STORAGE_KEY) === 'collapsed';
  } catch {
    /* localStorage unavailable */
    return false;
  }
}

export function storeRailCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) localStorage.setItem(RAIL_STORAGE_KEY, 'collapsed');
    else localStorage.removeItem(RAIL_STORAGE_KEY);
  } catch {
    /* ignore persistence failures */
  }
}

export const RAIL_NARROW_QUERY = '(max-width: 900px)';

function readNarrow(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(RAIL_NARROW_QUERY).matches
    : false;
}

export interface RailState {
  collapsed: boolean;
  /** True when the VIEWPORT (not the rep's preference) collapsed the rail. */
  forced: boolean;
  toggle: () => void;
}

/** Read-once-then-own state for the rail, persisted on every toggle; narrow
 *  viewports force `collapsed` without touching the stored preference. */
export function useRailCollapsed(): RailState {
  const [stored, setStored] = useState(readRailCollapsed);
  const [narrow, setNarrow] = useState(readNarrow);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(RAIL_NARROW_QUERY);
    const onChange = (e: MediaQueryListEvent): void => setNarrow(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  const toggle = useCallback(() => {
    setStored((prev) => {
      const next = !prev;
      storeRailCollapsed(next);
      return next;
    });
  }, []);

  return { collapsed: narrow || stored, forced: narrow, toggle };
}
