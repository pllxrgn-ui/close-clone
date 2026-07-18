import { useCallback, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

/*
 * Pointer-driven card drag, to the law: real pointer capture, transform-only
 * motion (no layout thrash), no bounce. A small threshold distinguishes a click
 * (select) from a drag. The drop target is hit-tested with elementFromPoint
 * against the nearest `[data-stage-id]`; the dragged card is pointer-events:none
 * while lifted (CSS) so the column beneath is what's found. The 180ms ease-out
 * settle on a cancelled drag is a CSS transition on the card, not JS.
 */

const DRAG_THRESHOLD_PX = 4;

export interface DragState {
  id: string;
  dx: number;
  dy: number;
  /** Stage the pointer is currently over, or null. */
  dropStageId: string | null;
}

interface UseCardDragParams {
  /** Current stage of a card (to ignore same-column drops). */
  stageOf: (oppId: string) => string | null;
  /** Commit a move once a card is dropped on a different stage. */
  onDrop: (oppId: string, stageId: string) => void;
  /** A clean click (pointer released without crossing the drag threshold). */
  onClick?: (oppId: string) => void;
}

export interface UseCardDragResult {
  drag: DragState | null;
  onCardPointerDown: (event: ReactPointerEvent<HTMLLIElement>, oppId: string) => void;
}

function stageIdAtPoint(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y);
  const host = el?.closest('[data-stage-id]');
  const id = host?.getAttribute('data-stage-id');
  return id && id.length > 0 ? id : null;
}

export function useCardDrag({ stageOf, onDrop, onClick }: UseCardDragParams): UseCardDragResult {
  const [drag, setDrag] = useState<DragState | null>(null);

  const onCardPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLLIElement>, oppId: string) => {
      // Left button / touch / pen only.
      if (event.pointerType === 'mouse' && event.button !== 0) return;

      const el = event.currentTarget;
      const startX = event.clientX;
      const startY = event.clientY;
      const pointerId = event.pointerId;
      let started = false;

      const move = (ev: PointerEvent): void => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!started && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        if (!started) {
          started = true;
          try {
            el.setPointerCapture(pointerId);
          } catch {
            /* capture unsupported (jsdom) — drag still tracks via listeners */
          }
        }
        setDrag({ id: oppId, dx, dy, dropStageId: stageIdAtPoint(ev.clientX, ev.clientY) });
      };

      const cleanup = (): void => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', cancel);
        try {
          el.releasePointerCapture(pointerId);
        } catch {
          /* no capture to release */
        }
      };

      const up = (ev: PointerEvent): void => {
        if (started) {
          const target = stageIdAtPoint(ev.clientX, ev.clientY);
          if (target && target !== stageOf(oppId)) onDrop(oppId, target);
        } else {
          // Released without crossing the threshold → a click, not a drag.
          onClick?.(oppId);
        }
        cleanup();
        setDrag(null);
      };

      const cancel = (): void => {
        cleanup();
        setDrag(null);
      };

      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', cancel);
    },
    [stageOf, onDrop, onClick],
  );

  return { drag, onCardPointerDown };
}
