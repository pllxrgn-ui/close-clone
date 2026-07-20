# Combobox primitive — design (2026-07-17)

Status: **implemented**. Single-select v1 ships with the primitive and the bulk-bar
owner/status/sequence migration.

## Problem

`apps/web/src/ui/` has a mature primitive set, but the one control it lacks is a
**searchable/autocomplete select**. Today every "pick one from a list" flow falls
back to either the native `<Select>` (no type-ahead, no async, no rich rows) or a
full-screen `Modal` — see `features/admin/bulk/pickers.tsx` `SelectDialog`, whose
own comment calls it "the owner / status / sequence picker." An inline Combobox is
the right primitive for those flows (assign owner, pick a sequence, choose a status).

## Non-goals (YAGNI)

- **Multi-select** (tags). Designed for as a future additive `multiple` variant that
  returns `string[]`; not built in v1. 3 of the 4 real call sites are single-select.
- **Free-text entry / create-new-option.** v1 selects from a provided list only.
- **Virtualized long lists.** Lists here are rep/status/sequence sized (tens, not
  thousands). Revisit only if a call site proves otherwise.

## Architecture

Fits the existing 3-layer model with **zero new dependencies**:

- Control markup + styles → `ui/Combobox.tsx`, `sb-combobox__*` in `primitives.css`.
- Portalled listbox panel + its entrance motion → `styles/overlays.css`, reusing the
  `sb-menu-in` keyframe and `--z-popover` layer (works inside modals).
- Positioning → the existing `useFloatingPosition` (same engine as Menu/Tooltip).
- Field wiring → `useFieldControl` (id / invalid / describedBy) so
  `<Field><Combobox/></Field>` is fully wired with no manual plumbing; when inside a
  `Field`, the visible label names the control and we suppress the standalone
  `aria-label` (avoid double-naming).

## Props / API (single-select v1)

```ts
interface ComboboxOption {
  value: string;
  label: string;
  sublabel?: string; // secondary line (email, count) — matches SelectOption
  accent?: string; // CSS color for a leading state bar (Lamp/DNC tone)
  disabled?: boolean;
}

interface ComboboxProps {
  options: ComboboxOption[];
  value: string | null;
  onChange: (value: string | null) => void;
  label: string; // required accessible name (Field overrides)
  placeholder?: string;
  loading?: boolean; // async fetch in flight → status + spinner
  disabled?: boolean;
  clearable?: boolean; // default true
  emptyLabel?: string; // default "No matches"
  onInputChange?: (query: string) => void; // present → server filters; absent → client
  id?: string;
  invalid?: boolean; // auto-supplied by Field
  className?: string;
  defaultOpen?: boolean; // reveal-in-place flows
  onClose?: () => void; // dismissal without a selection
}
```

Native-form serialization is intentionally omitted: every current call site is an
action picker. Add `name` only when a real form submission path needs it.

## Behavior / state model

- State: `open`, `query` (input text), `activeIndex` (into the shown list).
- Displayed input value = `query`. On commit → `query = option.label`, close, focus input,
  `onChange(value)`. On clear → `onChange(null)`, `query=''`, focus input. On
  close-without-commit (Escape / click-outside) → revert `query` to the selected label.
- Filtering: `onInputChange` present ⇒ parent owns `options` (server), we don't filter
  locally, just forward the query. Absent ⇒ client filter by `label`/`sublabel`
  substring (case-insensitive); empty term or `query === selectedLabel` shows all.
- Keyboard (input has `role="combobox"`, `aria-autocomplete="list"`): `↓/↑` open then
  move active (wrap, skip disabled); `Home/End`; `Enter` commits active; `Esc` closes +
  reverts + keeps focus; `Backspace` on empty clears when `clearable`; typing filters.
  Active option tracked via **`aria-activedescendant`** (focus stays in the input — the
  correct editable-combobox model), not roving tabindex.
- Mouse: click control toggles/opens; hovering an option sets `activeIndex` (keyboard +
  pointer agree); click option commits; pointerdown outside closes (Menu's pattern).

## States (full coverage)

closed (selected label / placeholder) · open+empty query (all options) · typing/filtering ·
**loading** (spinner + `aria-live` "Searching…") · **empty** (`emptyLabel`) ·
no options at all · disabled control · disabled option (skipped) · invalid (red ring via
Field) · long label (truncate + `title`) · selected (check mark on the row).

## Accessibility (APG combobox pattern, ARIA 1.2)

`role="combobox"` + `aria-expanded` + `aria-controls` + `aria-activedescendant` +
`aria-autocomplete="list"` on the input; portalled `role="listbox"` with
`role="option"` + `aria-selected`. An `aria-live="polite"` status announces result
count / "No matches" / "Searching". Escape restores focus to the input; the listbox is
never a tab stop.

## Motion (DESIGN.md §4)

Panel **enters** as a dropdown: `sb-menu-in` (`--dur` 180ms, `--ease-out`,
origin-aware via `data-side`/`data-align`). Arrowing options is keyboard-frequency →
**0ms highlight** (like `sb-menu__item`). `prefers-reduced-motion` → `animation: none`,
color/opacity retained.

## Testing (`Combobox.test.tsx`)

Roles + accessible name; open via `↓`; type-to-filter; `↓↑ Enter` selection →
`onChange`; click selection; clear → `onChange(null)`; `Esc` closes + restores focus;
disabled-option skipped; loading + empty render; server mode forwards query without
local filtering; Field association + `aria-invalid`; selected value shown in input.
