import { useCallback, useId, useRef, useState } from 'react';
import type { FocusEvent } from 'react';
import { useKeyBindings } from './useKeyBindings.ts';
import type { KeyBindingDef } from './types.ts';

export interface UseListNavOptions {
  /** Number of items in the list. */
  count: number;
  /** Called when the active item is activated (Enter / click). */
  onActivate?: (index: number) => void;
  initialIndex?: number;
  /** Wrap from last→first and first→last. Default false. */
  loop?: boolean;
  /** Cheat-sheet group label for the registered list bindings. */
  group?: string;
}

export interface ListItemProps {
  role: 'option';
  tabIndex: number;
  'aria-selected': boolean;
  ref: (el: HTMLElement | null) => void;
  onClick: () => void;
  onFocus: () => void;
}

export interface UseListNavResult {
  /** The clamped active index (-1 when the list is empty). */
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  /** Whether focus is currently inside the list container. */
  focusWithin: boolean;
  /** Spread onto the list container (role="listbox") to track focus. */
  containerProps: {
    onFocus: (event: FocusEvent) => void;
    onBlur: (event: FocusEvent) => void;
  };
  /** Spread onto each option element for roving tabindex + selection. */
  getItemProps: (index: number) => ListItemProps;
}

/**
 * Reusable j/k/enter list navigation with a roving tabindex.
 *
 * Registers `j`/`k` (+ ArrowDown/ArrowUp) and `Enter` in the `list` scope,
 * guarded by focus-within — so the bindings are inert (and shadowed by route/
 * global equivalents) until the user actually focuses the list. The active
 * item is the only one in the tab order; keyboard movement also moves DOM
 * focus so the focus ring and screen-reader position track the selection.
 */
export function useListNav(options: UseListNavOptions): UseListNavResult {
  const { count, onActivate, initialIndex = 0, loop = false, group = 'List' } = options;
  const baseId = useId();
  const itemsRef = useRef<Map<number, HTMLElement>>(new Map());
  const [rawActive, setRawActive] = useState(initialIndex);
  const [focusWithin, setFocusWithin] = useState(false);

  const clampIndex = useCallback(
    (index: number): number => {
      if (count <= 0) return 0;
      if (loop) return ((index % count) + count) % count;
      return Math.max(0, Math.min(count - 1, index));
    },
    [count, loop],
  );

  const activeIndex = count > 0 ? clampIndex(rawActive) : -1;

  const focusItem = (index: number): void => {
    itemsRef.current.get(index)?.focus();
  };

  const setActiveIndex = useCallback(
    (index: number) => setRawActive(clampIndex(index)),
    [clampIndex],
  );

  const move = (delta: number): void => {
    if (count <= 0) return;
    const next = clampIndex(activeIndex + delta);
    setRawActive(next);
    focusItem(next);
  };

  const activate = (): void => {
    if (count > 0) onActivate?.(activeIndex);
  };

  const listWhen = (): boolean => focusWithin;
  const defs: KeyBindingDef[] = [
    {
      id: `${baseId}-next`,
      combo: 'j',
      scope: 'list',
      label: 'Next item',
      group,
      when: listWhen,
      handler: () => move(1),
    },
    {
      id: `${baseId}-next-arrow`,
      combo: 'arrowdown',
      scope: 'list',
      label: 'Next item',
      group,
      hidden: true,
      when: listWhen,
      handler: () => move(1),
    },
    {
      id: `${baseId}-prev`,
      combo: 'k',
      scope: 'list',
      label: 'Previous item',
      group,
      when: listWhen,
      handler: () => move(-1),
    },
    {
      id: `${baseId}-prev-arrow`,
      combo: 'arrowup',
      scope: 'list',
      label: 'Previous item',
      group,
      hidden: true,
      when: listWhen,
      handler: () => move(-1),
    },
    {
      id: `${baseId}-open`,
      combo: 'enter',
      scope: 'list',
      label: 'Open item',
      group,
      when: listWhen,
      handler: activate,
    },
  ];
  useKeyBindings(defs);

  return {
    activeIndex,
    setActiveIndex,
    focusWithin,
    containerProps: {
      onFocus: () => setFocusWithin(true),
      onBlur: (event: FocusEvent) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setFocusWithin(false);
        }
      },
    },
    getItemProps: (index: number): ListItemProps => ({
      role: 'option',
      tabIndex: index === activeIndex ? 0 : -1,
      'aria-selected': index === activeIndex,
      ref: (el: HTMLElement | null) => {
        if (el) itemsRef.current.set(index, el);
        else itemsRef.current.delete(index);
      },
      onClick: () => {
        setRawActive(index);
        onActivate?.(index);
      },
      onFocus: () => setRawActive(index),
    }),
  };
}
