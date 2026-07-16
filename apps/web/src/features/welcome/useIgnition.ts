import { useEffect, useState } from 'react';

/*
 * Board-ignition guard for the landing hero.
 *
 * The hero plays its ignition choreography (grid fade-in → six state lamps
 * staggered → headline set) exactly ONCE per browser session, and never when
 * the visitor asks for reduced motion. Everything else on the page renders in
 * its final, lit state immediately.
 *
 * The decision is a pure function of two inputs (reduced-motion preference,
 * whether this session already ignited) so it is trivially testable; the hook
 * wires those inputs to the platform and records the "already ignited" flag.
 */

/** sessionStorage key — presence means the hero already ignited this session. */
export const IGNITION_SESSION_KEY = 'sb-welcome-ignited';

/**
 * `igniting` → the hero should animate its entrance this render.
 * `lit`      → render the final state with no choreography (instant).
 */
export type IgnitionState = 'igniting' | 'lit';

/** True when the visitor has requested reduced motion (feature-detected). */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Whether the hero has already ignited in this browser session. */
export function hasIgnitedThisSession(): boolean {
  try {
    return sessionStorage.getItem(IGNITION_SESSION_KEY) === '1';
  } catch {
    // Private-mode / disabled storage: treat as "not yet", but the caller's
    // markIgnited will also no-op, so at worst the entrance replays — never
    // throws.
    return false;
  }
}

/** Record that the hero ignited this session (so remounts stay `lit`). */
export function markIgnitedThisSession(): void {
  try {
    sessionStorage.setItem(IGNITION_SESSION_KEY, '1');
  } catch {
    /* ignore persistence failures — see hasIgnitedThisSession */
  }
}

/**
 * Pure ignition decision. Reduced motion or an already-ignited session both
 * collapse to `lit`; only a fresh, motion-allowed visit `igniting`.
 */
export function decideIgnition(reducedMotion: boolean, alreadyIgnited: boolean): IgnitionState {
  return reducedMotion || alreadyIgnited ? 'lit' : 'igniting';
}

/**
 * Resolve the hero's ignition state for this mount and, when it will animate,
 * burn the once-per-session flag so any later mount renders `lit`. The state is
 * computed synchronously in the initializer so there is no unlit flash before
 * an effect runs.
 */
export function useIgnition(): IgnitionState {
  const [state] = useState<IgnitionState>(() =>
    decideIgnition(prefersReducedMotion(), hasIgnitedThisSession()),
  );

  useEffect(() => {
    if (state === 'igniting') {
      markIgnitedThisSession();
    }
  }, [state]);

  return state;
}
