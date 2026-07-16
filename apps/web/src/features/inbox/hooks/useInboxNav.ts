import { useCallback, useId, useRef, useState } from 'react';
import { useKeyBindings } from '../../../keyboard/index.ts';
import type { KeyBindingDef } from '../../../keyboard/index.ts';

/*
 * Keyboard model for the Inbox queue: roving-tabindex J/K navigation over the
 * rows plus the one-key action verbs (Enter=primary, C=complete, R=reply,
 * S=snooze, A=approve, X=skip). Everything registers in the shared shortcut
 * registry (scope 'list', group "Inbox"), so it also appears in the `?` cheat
 * sheet.
 *
 * Bindings are gated by `enabled` (false while the composer is open or the queue
 * is empty) rather than by focus, so they stay documented in the cheat sheet even
 * when it steals focus, and never fire behind the open drawer. `allowInInput` is
 * left false, so no verb fires while the rep types a reply. Handlers get the
 * active index; the surface decides applicability by item kind (a mismatched key
 * is a silent no-op). Only the row body is a tab stop — the action buttons are
 * pointer/`?`-driven, so keyboard focus never lands on a button (no Enter
 * double-fire) and the structure stays free of nested interactive controls.
 */

export interface UseInboxNavOptions {
  count: number;
  enabled: boolean;
  onPrimary: (index: number) => void;
  onComplete: (index: number) => void;
  onReply: (index: number) => void;
  onSnooze: (index: number) => void;
  onApprove: (index: number) => void;
  onSkip: (index: number) => void;
}

export interface InboxRowProps {
  id: string;
  tabIndex: number;
  ref: (el: HTMLElement | null) => void;
  onClick: () => void;
  onFocus: () => void;
}

export interface UseInboxNavResult {
  activeIndex: number;
  rowId: (index: number) => string;
  getRowProps: (index: number) => InboxRowProps;
  /** Focus the currently active row (used after an action shifts the list). */
  focusActive: () => void;
}

export function useInboxNav(options: UseInboxNavOptions): UseInboxNavResult {
  const { count, enabled } = options;
  const baseId = useId();
  const rowsRef = useRef<Map<number, HTMLElement>>(new Map());
  const [rawActive, setRawActive] = useState(0);

  const clamp = useCallback(
    (index: number): number => {
      if (count <= 0) return 0;
      return Math.max(0, Math.min(count - 1, index));
    },
    [count],
  );

  const activeIndex = count > 0 ? clamp(rawActive) : -1;
  const rowId = useCallback((index: number): string => `${baseId}-row-${index}`, [baseId]);

  const focusRow = useCallback((index: number): void => {
    rowsRef.current.get(index)?.focus();
  }, []);

  const move = useCallback(
    (delta: number): void => {
      if (count <= 0) return;
      const next = clamp(activeIndex + delta);
      setRawActive(next);
      focusRow(next);
    },
    [count, clamp, activeIndex, focusRow],
  );

  const focusActive = useCallback((): void => {
    if (count <= 0) return;
    focusRow(clamp(rawActive));
  }, [count, clamp, rawActive, focusRow]);

  const when = (): boolean => enabled && count > 0;

  const defs: KeyBindingDef[] = [
    { id: `${baseId}-j`, combo: 'j', label: 'Next item', handler: () => move(1) },
    {
      id: `${baseId}-down`,
      combo: 'arrowdown',
      label: 'Next item',
      hidden: true,
      handler: () => move(1),
    },
    { id: `${baseId}-k`, combo: 'k', label: 'Previous item', handler: () => move(-1) },
    {
      id: `${baseId}-up`,
      combo: 'arrowup',
      label: 'Previous item',
      hidden: true,
      handler: () => move(-1),
    },
    {
      id: `${baseId}-enter`,
      combo: 'enter',
      label: 'Do the primary action',
      handler: () => options.onPrimary(activeIndex),
    },
    {
      id: `${baseId}-c`,
      combo: 'c',
      label: 'Complete task',
      handler: () => options.onComplete(activeIndex),
    },
    { id: `${baseId}-r`, combo: 'r', label: 'Reply', handler: () => options.onReply(activeIndex) },
    {
      id: `${baseId}-s`,
      combo: 's',
      label: 'Snooze until tomorrow',
      handler: () => options.onSnooze(activeIndex),
    },
    {
      id: `${baseId}-a`,
      combo: 'a',
      label: 'Approve step',
      handler: () => options.onApprove(activeIndex),
    },
    {
      id: `${baseId}-x`,
      combo: 'x',
      label: 'Skip step',
      handler: () => options.onSkip(activeIndex),
    },
  ].map((def) => ({ ...def, scope: 'list' as const, group: 'Inbox', when }));

  useKeyBindings(defs);

  return {
    activeIndex,
    rowId,
    focusActive,
    getRowProps: (index: number): InboxRowProps => ({
      id: rowId(index),
      tabIndex: index === activeIndex ? 0 : -1,
      ref: (el: HTMLElement | null) => {
        if (el) rowsRef.current.set(index, el);
        else rowsRef.current.delete(index);
      },
      onClick: () => setRawActive(index),
      onFocus: () => setRawActive(index),
    }),
  };
}
