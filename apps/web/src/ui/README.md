# `ui/` — Switchboard UI primitives

The hand-built, dependency-free base layer for the **Operator Grid** identity
(`DESIGN.md` is law here). Every screen composes these; feature code should not
hand-roll a control, an error block, or an overlay that exists in this
directory.

## Architecture

Three layers, strictly ordered:

```
styles/tokens.css      design law: color, type, spacing, motion, z-index (both themes)
        │
ui/  (this dir)        primitives: one component per file, styled by sb-* classes
        │                in primitives.css (+ overlay pieces in styles/overlays.css)
        │
features/*             product surfaces: compose primitives, own their layout CSS
```

Rules that keep it scalable:

- **Tokens only.** No hex, no px-spacing literals in component CSS — everything
  resolves through `tokens.css`, which is how both themes and the AA contrast
  guarantees hold without touching a `.tsx`.
- **One component per file**, named export + exported `…Props` interface,
  re-exported from `index.ts`. Import as `import { Button, Field } from '../ui'`
  (path depth varies).
- **CSS classes, not CSS-in-JS.** Components emit `sb-*` classes; state rides on
  ARIA attributes (`[aria-invalid]`, `[aria-checked]`, `[aria-selected]`) or
  `data-*`, so styling and semantics can't drift apart.
- **Zero UI dependencies.** Modal, Menu, Tooltip, Tabs are hand-built on ARIA
  patterns (APG). The only third-party visual dep is `lucide-react`, wrapped
  once in `icons.tsx` (stroke 1.5, decorative-by-default — pass `title` to make
  an icon meaningful).
- **Motion law is enforced here** so features inherit it: keyboard-frequency
  actions never animate (tabs, palette, row selection), pointer feedback stays
  under 300ms, `transform`/`opacity` only, hover gated to
  `(hover: hover) and (pointer: fine)`, `prefers-reduced-motion` keeps
  opacity/color and drops movement.

## Inventory

| Component                                       | Use for                                             | Key a11y contract                                     |
| ----------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------- |
| `Button` / `IconButton`                         | Actions. `loading` disables + `aria-busy` + spinner | `IconButton` requires `label`                         |
| `Input` / `Textarea` / `Select`                 | Form values                                         | `invalid` → `aria-invalid`; auto-wired inside `Field` |
| `Field`                                         | Label + control + hint + error                      | `htmlFor`, `aria-describedby`, `role="alert"` error   |
| `Checkbox`                                      | Form boolean / bulk-select (`indeterminate`)        | real `<input>`, Space, label click                    |
| `Switch`                                        | Immediate-effect setting (NOT a form value)         | `role="switch"`, `aria-checked`                       |
| `Tabs` (+`TabList`/`Tab`/`TabPanel`)            | In-page view switch                                 | roving tabindex, arrows activate, 0ms                 |
| `Menu` (+`MenuItem`/`MenuSeparator`)            | Action dropdown ("⋯")                               | APG menu keyboard, focus restore                      |
| `Tooltip`                                       | Label icon-only/ambiguous controls                  | shows on focus too; Escape; never on disabled         |
| `Modal`                                         | Centered dialog                                     | focus trap, Escape, focus restore                     |
| `Drawer`                                        | Edge-docked dialog (compose, enroll)                | = Modal contract + slide entrance                     |
| `EmptyState`                                    | Zero-data                                           | —                                                     |
| `ErrorState`                                    | Failed-to-load + retry                              | `role="alert"`, always offers a way forward           |
| `Spinner` / `Skeleton`                          | Loading (bounded / layout-shaped)                   | `role="status"` / `aria-hidden`                       |
| `StatusPill`, `Lamp`, `LampRail`, `StateLegend` | The six-state color system                          | see `DESIGN.md` §2                                    |
| `Kbd`, `ListRow`, `VisuallyHidden`              | Keycaps, dense rows, SR-only text                   | —                                                     |

## Usage

### A form field — `Field` does all the wiring

```tsx
<Field label="Work email" hint="Used for the daily digest" error={errors.email} required>
  <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
</Field>
```

`Field` generates the ids: label→control association, `aria-describedby` for
hint **and** error, `aria-invalid` when `error` is set, `role="alert"` so the
error is announced when it appears. Works with `Input`, `Textarea`, `Select`,
`Checkbox`, `Switch`; explicit `id`/`aria-describedby`/`invalid` on the control
win. **One label wins:** inside a `Field`, omit the `Checkbox`/`Switch` inline
`label` prop — the Field label already names the control, and two labels
concatenate the accessible name (a dev-mode warning fires).

### Async pane — cover all four states, in this order

```tsx
if (query.isPending) return <Skeleton height={rowHeight * 5} />; // shaped like the data
if (query.isError)
  return <ErrorState title="Couldn't load contacts" onRetry={() => query.refetch()} />;
if (query.data.length === 0)
  return <EmptyState title="No contacts" actions={<Button>Add contact</Button>} />;
return <ContactList data={query.data} />;
```

### Action menu

```tsx
<Menu
  label="Lead actions"
  align="end"
  trigger={(props) => (
    <IconButton {...props} label="Lead actions">
      <EllipsisIcon />
    </IconButton>
  )}
>
  <MenuItem icon={<SettingsIcon />} onSelect={openEdit}>
    Edit lead
  </MenuItem>
  <MenuItem onSelect={merge} disabled={!canMerge}>
    Merge…
  </MenuItem>
  <MenuSeparator />
  <MenuItem tone="danger" onSelect={confirmDelete}>
    Delete
  </MenuItem>
</Menu>
```

The `trigger` render prop receives `ref`, `aria-*` and handlers — spread them
onto any button-shaped primitive. Items run actions; to pick a value use
`Select`.

### Tabs (controlled)

```tsx
const [tab, setTab] = useState('calls');
<Tabs value={tab} onValueChange={setTab}>
  <TabList label="Report sections">
    <Tab value="calls">Calls</Tab>
    <Tab value="emails">Emails</Tab>
  </TabList>
  <TabPanel value="calls">
    <CallsReport />
  </TabPanel>
  <TabPanel value="emails">
    <EmailsReport />
  </TabPanel>
</Tabs>;
```

`value` strings become element ids — keep them slugs. Panel content unmounts
when inactive (no hidden queries firing).

### Drawer

```tsx
<Drawer open={open} onClose={close} label="Compose reply" initialFocusRef={bodyRef}>
  …composer…
</Drawer>
```

### Tooltip

```tsx
<Tooltip content="Copy lead id">
  <IconButton label="Copy lead id">
    <CopyIcon />
  </IconButton>
</Tooltip>
```

The tooltip **supplements** the accessible name (`aria-describedby`), it does
not replace it — `IconButton` still needs `label`. First show waits ~350ms;
scrubbing across a toolbar shows siblings instantly. Never on a disabled
element (no events fire) — wrap it or use inline text.

## Best practices (the craft bar, enforced in review)

1. **States are not optional.** Every data surface ships default, loading,
   error (with retry), and empty. Every control ships hover, focus-visible,
   active, and disabled — the CSS here already does; don't override it away.
2. **Keyboard path for everything.** If it opens, Escape closes it and focus
   returns to the opener. If it's a list, arrows move through it. Test with the
   Tab key before calling it done.
3. **Accessible names come first.** `IconButton label`, `Menu label`,
   `TabList label`, `Modal label`/`labelledBy` are required props by design —
   never stub them with `""`.
4. **Color is information.** Chrome stays achromatic (checked = ink, not cyan);
   the six state tokens are the entire color budget and `danger`/DNC red is
   reserved for destructive/blocked. Don't introduce new colors in feature CSS.
5. **Don't animate what repeats.** Keyboard-driven switches are 0ms. If you add
   motion, it's `transform`/`opacity`, under 300ms, `--ease-out`, and gated for
   reduced motion. (`DESIGN.md` §4 is normative.)
6. **Compose, don't fork.** Need a variant? Extend the primitive (additive prop
   or a class hook) rather than copying its markup into a feature. If two
   features hand-roll the same thing, it belongs here.
7. **Long content is a state.** Truncate with ellipsis inside rows/menus
   (`min-width: 0` on flex children), never let a name push a layout.
8. **Tests ride with the component** (`*.test.tsx` beside the file): roles,
   keyboard paths, aria wiring, and at least one failure path (disabled item
   doesn't fire, closed drawer renders nothing).
