import { useCallback, useState } from 'react';

/*
 * Left-rail collapse state. A rep's rail preference should survive reloads and
 * route changes, so the choice is persisted to localStorage under `sb-rail`
 * (same try/catch discipline as the theme module: storage can throw in private
 * mode). Collapsing is a pointer action on a persistent preference, not a view
 * transition — there is no animation (law §4: no casual layout-property motion).
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

export interface RailState {
  collapsed: boolean;
  toggle: () => void;
}

/** Read-once-then-own state for the rail, persisted on every toggle. */
export function useRailCollapsed(): RailState {
  const [collapsed, setCollapsed] = useState(readRailCollapsed);
  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      storeRailCollapsed(next);
      return next;
    });
  }, []);
  return { collapsed, toggle };
}
