import { useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, JSX, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../lib/cx.ts';
import { useFloatingPosition } from './floating.ts';
import { FieldContext, useFieldControl } from './fieldContext.ts';
import { ChevronDownIcon, CheckIcon, CloseIcon, SearchIcon } from './icons.tsx';
import { IconButton } from './IconButton.tsx';
import { Spinner } from './Spinner.tsx';

/*
 * Combobox — searchable single-select (APG combobox pattern, ARIA 1.2).
 *
 * An editable input (role="combobox") anchoring a portalled listbox. Type to
 * filter; the active option is tracked via aria-activedescendant so FOCUS STAYS
 * IN THE INPUT (the correct editable-combobox model — not roving tabindex).
 * Positioning + click-outside + Escape reuse the same engine as <Menu>; no new
 * deps. For a plain fixed list use <Select>; for actions use <Menu>.
 *
 * Motion (DESIGN.md §4): the panel ENTERS as a dropdown (origin-aware, 180ms,
 * transform+opacity) but arrowing options is keyboard-frequency navigation, so
 * the active-option highlight is 0ms. prefers-reduced-motion drops the entrance.
 */

export interface ComboboxOption {
  value: string;
  label: string;
  /** Secondary line (email, count) — also matched when filtering. */
  sublabel?: string;
  /** CSS color for the row's leading state bar (a Lamp/DNC tone). */
  accent?: string;
  disabled?: boolean;
}

export interface ComboboxProps {
  options: ComboboxOption[];
  value: string | null;
  onChange: (value: string | null) => void;
  /** Accessible name. A wrapping <Field> supplies it instead (label wins). */
  label: string;
  placeholder?: string;
  /** Async fetch in flight → a "Searching…" status is announced in the list. */
  loading?: boolean;
  disabled?: boolean;
  /** Show a clear affordance + allow Backspace-to-clear when set. Default true. */
  clearable?: boolean;
  emptyLabel?: string;
  /** Present → the parent owns filtering (server); absent → filter client-side. */
  onInputChange?: (query: string) => void;
  /** Mount already open + focused. For "reveal a picker in place" flows. */
  defaultOpen?: boolean;
  /** Fires when the listbox closes WITHOUT a selection (Esc / outside / blur). */
  onClose?: () => void;
  id?: string;
  invalid?: boolean;
  className?: string;
}

function firstEnabled(options: ComboboxOption[]): number {
  return options.findIndex((o) => !o.disabled);
}
function lastEnabled(options: ComboboxOption[]): number {
  for (let i = options.length - 1; i >= 0; i -= 1) if (!options[i]?.disabled) return i;
  return -1;
}
/** Next enabled index from `from` moving by `dir`, wrapping; -1 if none. */
function stepEnabled(options: ComboboxOption[], from: number, dir: 1 | -1): number {
  const n = options.length;
  if (n === 0) return -1;
  for (let i = 1; i <= n; i += 1) {
    const idx = (from + dir * i + n * i) % n;
    if (!options[idx]?.disabled) return idx;
  }
  return -1;
}

export function Combobox({
  options,
  value,
  onChange,
  label,
  placeholder,
  loading = false,
  disabled = false,
  clearable = true,
  emptyLabel = 'No matches',
  onInputChange,
  defaultOpen = false,
  onClose,
  id,
  invalid,
  className,
}: ComboboxProps): JSX.Element {
  const listId = useId();
  const inField = useContext(FieldContext) !== null;
  const field = useFieldControl({ id, invalid });

  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const openFromEnd = useRef(false);
  const position = useFloatingPosition(open, wrapperRef, panelRef, {
    side: 'bottom',
    align: 'start',
  });

  const selected = useMemo(() => options.find((o) => o.value === value) ?? null, [options, value]);

  // Client filtering. Server mode (onInputChange set) shows options verbatim.
  const shown = useMemo(() => {
    if (onInputChange) return options;
    const term = query.trim().toLowerCase();
    if (term.length === 0 || (selected && query === selected.label)) return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(term) || (o.sublabel?.toLowerCase().includes(term) ?? false),
    );
  }, [options, query, onInputChange, selected]);

  // When closed, the input mirrors the selection (revert-on-cancel is free).
  useEffect(() => {
    if (open) return;
    setQuery(selected ? selected.label : '');
  }, [selected, open]);

  // On open (or when the filtered set changes) point the active option at the
  // selection if visible, else the first enabled row.
  useEffect(() => {
    if (!open) return;
    if (openFromEnd.current) {
      openFromEnd.current = false;
      setActiveIndex(lastEnabled(shown));
      return;
    }
    const selIdx = shown.findIndex((o) => o.value === value && !o.disabled);
    setActiveIndex(selIdx >= 0 ? selIdx : firstEnabled(shown));
  }, [open, shown, value]);

  // Click-outside closes (mirrors <Menu>; the panel is portalled to <body>).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (wrapperRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      closeCancel();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // Keep the active row in view during keyboard nav (no-op in jsdom).
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const escape = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape : (s: string) => s;
    panelRef.current
      ?.querySelector(`#${escape(`${listId}-opt-${activeIndex}`)}`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeIndex, listId]);

  // Focus the field when it mounts already open (reveal-in-place flows).
  // Mount-only: defaultOpen is an initial condition, not a live toggle.
  const didAutofocus = useRef(false);
  useEffect(() => {
    if (defaultOpen && !didAutofocus.current) {
      didAutofocus.current = true;
      inputRef.current?.focus();
    }
  }, [defaultOpen]);

  function commit(option: ComboboxOption | undefined): void {
    if (!option || option.disabled) return;
    onChange(option.value);
    setQuery(option.label);
    setOpen(false);
    inputRef.current?.focus();
  }

  /** Close without a selection (Escape / click-outside / blur) → notify. */
  function closeCancel(): void {
    setOpen(false);
    onClose?.();
  }

  function clear(): void {
    onChange(null);
    setQuery('');
    inputRef.current?.focus();
  }

  function onInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (!open) setOpen(true);
        else setActiveIndex((i) => stepEnabled(shown, i, 1));
        return;
      case 'ArrowUp':
        event.preventDefault();
        if (!open) {
          openFromEnd.current = true;
          setOpen(true);
        } else setActiveIndex((i) => stepEnabled(shown, i, -1));
        return;
      case 'Home':
        if (!open) return;
        event.preventDefault();
        setActiveIndex(firstEnabled(shown));
        return;
      case 'End':
        if (!open) return;
        event.preventDefault();
        setActiveIndex(lastEnabled(shown));
        return;
      case 'Enter':
        if (!open) return;
        event.preventDefault();
        commit(shown[activeIndex]);
        return;
      case 'Escape':
        if (!open) return;
        event.preventDefault();
        event.stopPropagation();
        closeCancel(); // the [selected, open] effect reverts the query text
        return;
      case 'Backspace':
        if (clearable && value !== null && query.length === 0) {
          event.preventDefault();
          clear();
        }
        return;
      default:
    }
  }

  const activeOptionId = open && activeIndex >= 0 ? `${listId}-opt-${activeIndex}` : undefined;
  const showClear = clearable && value !== null && !disabled;

  return (
    <div
      ref={wrapperRef}
      className={cx('sb-combobox', className)}
      data-open={open || undefined}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (wrapperRef.current?.contains(next) || panelRef.current?.contains(next)) return;
        if (open) closeCancel();
      }}
    >
      <div className="sb-combobox__control" data-invalid={field.invalid || undefined}>
        <SearchIcon className="sb-combobox__lead" size={14} />
        <input
          ref={inputRef}
          id={field.id}
          role="combobox"
          type="text"
          className="sb-combobox__input"
          value={query}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={activeOptionId}
          aria-autocomplete="list"
          aria-invalid={field.invalid || undefined}
          aria-describedby={field.describedBy}
          {...(inField ? {} : { 'aria-label': label })}
          onChange={(event) => {
            const next = event.target.value;
            setQuery(next);
            if (!open) setOpen(true);
            onInputChange?.(next);
          }}
          onKeyDown={onInputKeyDown}
          onMouseDown={() => {
            if (!disabled && !open) setOpen(true);
          }}
        />
        {showClear ? (
          <IconButton
            label="Clear selection"
            size="sm"
            className="sb-combobox__clear"
            tabIndex={-1}
            onClick={clear}
          >
            <CloseIcon size={14} />
          </IconButton>
        ) : null}
        <ChevronDownIcon className="sb-combobox__chevron" size={14} />
      </div>

      {open
        ? createPortal(
            <div
              ref={panelRef}
              className="sb-combobox__panel"
              data-side={position.side}
              style={{ ...position.style, minWidth: position.anchorWidth || undefined }}
              // Keep focus in the input when clicking a row (no blur-close race).
              onMouseDown={(event) => event.preventDefault()}
            >
              {!loading ? (
                <span role="status" aria-live="polite" className="sb-visually-hidden">
                  {shown.length === 0
                    ? emptyLabel
                    : `${shown.length} ${shown.length === 1 ? 'result' : 'results'} available`}
                </span>
              ) : null}
              <ul id={listId} role="listbox" aria-label={label} className="sb-combobox__list">
                {loading ? (
                  <li role="presentation" className="sb-combobox__status">
                    <Spinner label="Searching" />
                    <span>Searching…</span>
                  </li>
                ) : null}
                {!loading && shown.length === 0 ? (
                  <li role="presentation" className="sb-combobox__empty">
                    {emptyLabel}
                  </li>
                ) : null}
                {shown.map((option, index) => {
                  const isSelected = option.value === value;
                  const isActive = index === activeIndex;
                  return (
                    <li
                      key={option.value}
                      id={`${listId}-opt-${index}`}
                      role="option"
                      aria-selected={isSelected}
                      aria-disabled={option.disabled || undefined}
                      className="sb-combobox__option"
                      data-active={isActive || undefined}
                      data-accent={option.accent ? '' : undefined}
                      style={
                        option.accent
                          ? ({ '--cb-accent': option.accent } as CSSProperties)
                          : undefined
                      }
                      onMouseMove={() => {
                        if (!option.disabled && !isActive) setActiveIndex(index);
                      }}
                      onClick={() => commit(option)}
                    >
                      <span className="sb-combobox__option-text">
                        <span className="sb-combobox__option-label">{option.label}</span>
                        {option.sublabel ? (
                          <span className="sb-combobox__option-sub">{option.sublabel}</span>
                        ) : null}
                      </span>
                      {isSelected ? <CheckIcon className="sb-combobox__check" size={14} /> : null}
                    </li>
                  );
                })}
              </ul>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
