import { useEffect, useRef } from 'react';
import type { JSX, KeyboardEvent, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../lib/cx.ts';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name (use this OR labelledBy). */
  label?: string;
  labelledBy?: string;
  describedBy?: string;
  /** Element to focus on open; falls back to the dialog itself. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  className?: string;
  /** Extra class on the backdrop (e.g. to top-align the command palette). */
  backdropClassName?: string;
  children: ReactNode;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A minimal, dependency-free modal primitive: portalled to <body>, role=dialog +
 * aria-modal, focus moved in on open and restored to the opener on close, Escape
 * to close, and a Tab focus trap. Entrance motion is CSS-only, so it collapses to
 * instant under prefers-reduced-motion (see base.css / overlays.css).
 */
export function Modal({
  open,
  onClose,
  label,
  labelledBy,
  describedBy,
  initialFocusRef,
  className,
  backdropClassName,
  children,
}: ModalProps): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const target = initialFocusRef?.current ?? dialogRef.current;
    target?.focus();
    return () => {
      restoreRef.current?.focus?.();
    };
  }, [open, initialFocusRef]);

  if (!open) return null;

  function trapTab(event: KeyboardEvent): void {
    const root = dialogRef.current;
    if (!root) return;
    const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusables.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !root.contains(active)) {
        event.preventDefault();
        last?.focus();
      }
    } else if (active === last || !root.contains(active)) {
      event.preventDefault();
      first?.focus();
    }
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'Tab') {
      trapTab(event);
    }
  }

  return createPortal(
    <div
      className={cx('sb-overlay', backdropClassName)}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={cx('sb-modal', className)}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
