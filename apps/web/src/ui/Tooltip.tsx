import { Children, cloneElement, isValidElement, useEffect, useId, useRef, useState } from 'react';
import type { JSX, PointerEvent as ReactPointerEvent, ReactElement, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../lib/cx.ts';
import { useFloatingPosition } from './floating.ts';

export interface TooltipProps {
  /** Short text only — a tooltip is a label, not a place for controls. */
  content: ReactNode;
  side?: 'top' | 'bottom';
  className?: string;
  /** A single focusable element; handlers and aria-describedby are merged in. */
  children: ReactElement<Record<string, unknown>>;
}

/*
 * First show waits SHOW_DELAY; once one tooltip has been seen, siblings within
 * INSTANT_WINDOW show immediately AND skip the entrance animation — scrubbing
 * across a toolbar reads each label without re-waiting (the Emil rule).
 */
const SHOW_DELAY_MS = 350;
const INSTANT_WINDOW_MS = 600;
let lastHiddenAt = Number.NEGATIVE_INFINITY;

function composeHandlers<E>(theirs: unknown, ours: (event: E) => void): (event: E) => void {
  return (event: E) => {
    if (typeof theirs === 'function') (theirs as (event: E) => void)(event);
    ours(event);
  };
}

/**
 * Hover/focus label for icon-only or ambiguous controls. Portalled, flips when
 * out of room, Escape dismisses, hidden from touch (no hover to hold it).
 * Never put a tooltip on a disabled element — it fires no events; wrap it or
 * use inline text instead.
 */
export function Tooltip({ content, side = 'top', className, children }: TooltipProps): JSX.Element {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [instant, setInstant] = useState(false);
  const anchorRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const position = useFloatingPosition(open, anchorRef, panelRef, {
    side,
    align: 'center',
    offset: 6,
  });

  function clearTimer(): void {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  function show(immediate: boolean): void {
    clearTimer();
    const withinWindow = performance.now() - lastHiddenAt < INSTANT_WINDOW_MS;
    if (immediate || withinWindow) {
      setInstant(withinWindow);
      setOpen(true);
      return;
    }
    timerRef.current = window.setTimeout(() => {
      setInstant(false);
      setOpen(true);
    }, SHOW_DELAY_MS);
  }

  function hide(): void {
    clearTimer();
    if (open) lastHiddenAt = performance.now();
    setOpen(false);
  }

  useEffect(() => clearTimer, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') hide();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const child = Children.only(children);
  if (!isValidElement(child)) return child;
  const childProps = child.props;

  const trigger = cloneElement(child, {
    // React 19: ref is a regular prop — merge ours with the child's own.
    ref: (node: HTMLElement | null) => {
      anchorRef.current = node;
      const theirRef = childProps.ref;
      if (typeof theirRef === 'function') theirRef(node);
      else if (theirRef && typeof theirRef === 'object' && 'current' in theirRef) {
        (theirRef as { current: HTMLElement | null }).current = node;
      }
    },
    'aria-describedby': open
      ? cx(id, typeof childProps['aria-describedby'] === 'string' && childProps['aria-describedby'])
      : childProps['aria-describedby'],
    onPointerEnter: composeHandlers(childProps.onPointerEnter, (event: ReactPointerEvent) => {
      if (event.pointerType === 'touch') return;
      show(false);
    }),
    onPointerLeave: composeHandlers(childProps.onPointerLeave, hide),
    onFocus: composeHandlers(childProps.onFocus, () => show(true)),
    onBlur: composeHandlers(childProps.onBlur, hide),
    onPointerDown: composeHandlers(childProps.onPointerDown, hide),
  });

  return (
    <>
      {trigger}
      {open
        ? createPortal(
            <div
              ref={panelRef}
              id={id}
              role="tooltip"
              className={cx('sb-tooltip', className)}
              data-side={position.side}
              data-instant={instant || undefined}
              style={position.style}
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
