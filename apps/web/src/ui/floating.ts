import { useLayoutEffect, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';

/*
 * Tiny dependency-free anchored positioning for the portal primitives
 * (Tooltip, Menu). Fixed-position coordinates from the anchor's rect, a
 * vertical flip when the preferred side doesn't fit, a horizontal clamp to
 * the viewport, and re-position on scroll/resize while open. Deliberately
 * not a Floating UI replacement — two sides, three alignments, one offset.
 */

export interface FloatingOptions {
  side?: 'top' | 'bottom';
  align?: 'start' | 'center' | 'end';
  /** Gap between anchor and panel, px. */
  offset?: number;
}

export interface FloatingPosition {
  style: CSSProperties;
  anchorWidth: number;
  /** Side actually used after flipping — drives transform-origin via data-side. */
  side: 'top' | 'bottom';
}

const VIEWPORT_MARGIN = 8;

function compute(
  anchor: HTMLElement,
  panel: HTMLElement,
  { side = 'bottom', align = 'start', offset = 4 }: FloatingOptions,
): FloatingPosition {
  const a = anchor.getBoundingClientRect();
  const p = panel.getBoundingClientRect();

  let actualSide = side;
  if (side === 'bottom' && a.bottom + offset + p.height > window.innerHeight - VIEWPORT_MARGIN) {
    if (a.top - offset - p.height >= VIEWPORT_MARGIN) actualSide = 'top';
  } else if (side === 'top' && a.top - offset - p.height < VIEWPORT_MARGIN) {
    if (a.bottom + offset + p.height <= window.innerHeight - VIEWPORT_MARGIN) {
      actualSide = 'bottom';
    }
  }
  const top = actualSide === 'bottom' ? a.bottom + offset : a.top - offset - p.height;

  let left = a.left;
  if (align === 'center') left = a.left + a.width / 2 - p.width / 2;
  else if (align === 'end') left = a.right - p.width;
  const maxLeft = window.innerWidth - VIEWPORT_MARGIN - p.width;
  left = Math.min(Math.max(left, VIEWPORT_MARGIN), Math.max(maxLeft, VIEWPORT_MARGIN));

  // Vertical clamp: a panel taller than the remaining space must not run off
  // the viewport (the flip above already picked the roomier side).
  const maxTop = window.innerHeight - VIEWPORT_MARGIN - p.height;
  const clampedTop = Math.min(Math.max(top, VIEWPORT_MARGIN), Math.max(maxTop, VIEWPORT_MARGIN));

  return {
    style: { position: 'fixed', top: Math.round(clampedTop), left: Math.round(left) },
    anchorWidth: Math.round(a.width),
    side: actualSide,
  };
}

/**
 * Position a portalled panel against an anchor while `open`. Measures after
 * the panel mounts (layout effect — no visible jump) and re-measures on
 * scroll (capture, so any scroll container counts) and resize.
 */
export function useFloatingPosition(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLElement | null>,
  options: FloatingOptions = {},
): FloatingPosition {
  const { side = 'bottom', align = 'start', offset = 4 } = options;
  const [position, setPosition] = useState<FloatingPosition>({
    style: { position: 'fixed', top: 0, left: 0 },
    anchorWidth: 0,
    side,
  });

  useLayoutEffect(() => {
    if (!open) return;
    const update = (): void => {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      setPosition(compute(anchor, panel, { side, align, offset }));
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open, anchorRef, panelRef, side, align, offset]);

  return position;
}
