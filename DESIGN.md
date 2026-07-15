# DESIGN — Switchboard visual identity: "Operator Grid" (A × C, locked 2026-07-16)

Chosen by the user from the direction boards (artifact `switchboard-design-directions`): **A Operator Console × C Signal Grid**. This file is design law for every web task, alongside the build guide §7 brief. Motion and craft standards below are normative and derive from the installed `emil-design-eng` and `impeccable-taste` skills — implementers get the distilled rules inline in their prompts.

## 1. Identity

A patch-bay for deals on a live board. Graphite instrument surfaces and condensed engineering type (from A); the lamp-rail state system, glow discipline, and wide-caps labels (from C). Dark-first — the light theme is brushed instrument-panel silver, designed with equal care, never naive inversion. Nothing decorative: the only color on the surface is information.

## 2. Tokens (source of truth: `apps/web/src/styles/tokens.css`)

### Surfaces & ink (dark / light)
| Token | Dark | Light |
|---|---|---|
| `--bg` (app) | `#141719` | `#ECEDEB` |
| `--panel` | `#1B1F23` | `#F7F7F5` |
| `--panel-raised` | `#22272C` | `#FFFFFF` |
| `--line` | `#30363C` | `#D4D6D3` |
| `--ink` | `#E8EBEC` | `#1B1E20` |
| `--ink-dim` | `#8C949C` | `#5A6065` |
| `--focus` | `#56C8FF` | `#0B7FC4` |

### State (the entire color budget; AA on both grounds)
| Token | Dark | Light | Meaning |
|---|---|---|---|
| `--state-reply` | `#2EE6A8` | `#0E7A57` | new inbound / needs answer |
| `--state-overdue` | `#FFB224` | `#8F5B00` | overdue task / SLA breach |
| `--state-seq` | `#B18CFF` | `#5A3EA6` | in sequence / automated touch |
| `--state-dnc` | `#FF4F66` | `#B01E33` | DNC / suppressed — hard stop |
| `--state-live` | `#56C8FF` | `#0B7FC4` | live call / active selection |
| `--state-idle` | `#4A5258` | `#9AA0A3` | no signal |

Glow (`box-shadow: 0 0 8px currentColor`) is reserved for lamps whose state demands attention (reply, live); overdue/seq/dnc are flat. Light theme: lamps are solid dots, no glow — printed, not lit.

### Geometry & density
Radii: 2px (inputs, buttons), 0px (panels, rows — square jacks). Row height 36px dense default / 44px comfortable toggle. Spacing scale 4/8/12/16/24/32. Grid texture (C's 44px etched grid) appears ONLY on the landing hero and board/section headers — never behind data.

## 3. Type

| Role | Face (self-hosted; no CDN) | Fallback until fonts land |
|---|---|---|
| Display (big numbers, hero, section heads) | **IBM Plex Sans Condensed** 600/700 | Arial Narrow |
| Body / UI | **Inter** 400/500/650 | Segoe UI / system-ui |
| Data (ids, timestamps, amounts, kbd) | **JetBrains Mono** 400/600 | Consolas |

`font-variant-numeric: tabular-nums` wherever digits align. Wide-tracked uppercase (`.14–.28em`) for section labels and state words only. Body measure ≤ 65ch in prose surfaces.

## 4. Motion law (product register)

Normative, from emil-design-eng — violations are review-blockers:
- **Never animate keyboard-initiated actions.** Command palette, `J/K` navigation, shortcut-driven view switches: 0ms, ever. (Raycast rule.)
- Only `transform` + `opacity`; no casual layout-property animation (use grid-rows/FLIP for expansion).
- Curves: `--ease-out: cubic-bezier(0.23,1,0.32,1)`; `--ease-in-out: cubic-bezier(0.77,0,0.175,1)`. Never `ease-in`, never bounce/elastic.
- Durations: press 100–160ms (`scale(0.97)` on `:active`); tooltips 125–200ms (instant on subsequent); dropdowns 150–250ms; modals/drawers 200–500ms; **everything UI < 300ms**; exits ≈ 75% of enter.
- Never `scale(0)` — enter from `scale(0.95–0.97)` + `opacity: 0`; popovers origin-aware from their trigger (modals exempt, stay centered).
- CSS transitions over keyframes for anything rapid-fire (toasts, lamps); `@starting-style` for entries.
- Stagger 30–80ms, decorative only, capped ≤ 500ms total.
- Hover motion gated behind `@media (hover: hover) and (pointer: fine)`; `prefers-reduced-motion` = gentler (keep opacity/color, drop movement), not zero.
- Lamp pulse (reply/live states): 2.2s ease-in-out opacity oscillation, the ONLY ambient motion in the product; suspended under reduced-motion.

## 5. Motion law (landing register)

One signature entrance, not scattered reveals: the board lights up — grid fades in, lamps ignite in a 30–80ms stagger, the headline sets. 500–800ms total, once. No scroll-fade-on-every-section; scroll motion only where it explains the product (e.g. the lead-row → timeline morph demo). Everything else per product register.

## 6. Craft bar (from impeccable — definition of done for every web task)

Real content, never lorem · semantic HTML first · full state coverage (default/hover/focus-visible/active/disabled/loading/error/empty/overflow/long-text) · keyboard path for everything, visible focus (`--focus` ring, 2px offset) · one icon set (lucide-react, stroke 1.5) · tabular-nums for data · deliberate spacing from the scale, no arbitrary margins · no console errors, no layout shift · screenshot + honest critique + patch before presenting.

## 7. Landing page ("the front door", route `/welcome`, unauthenticated)

Structure: nav (wordmark + "Sign in · SSO") → hero (board-ignition moment, headline "Pick up the line. The rest is already dialed.", sub + `Open Switchboard →` CTA) → three feature acts told as board vignettes (Inbox triage · one-keystroke calling · sequences that stop themselves) with real product frames → keyboard strip (the actual shortcut map as a design object) → compliance/trust line (recording consent, unsubscribe, DNC honored by engine) → footer CTA. Copy voice: operator's economy — short declaratives, zero marketing froth, numbers where words would be ("0.9s to open a lead").

## 8. Application plan

- `W1–W4` (running) build structure/behavior with placeholder-neutral tokens; **W5 "re-skin + motion pass"** applies this file: tokens.css rewrite, font self-hosting, lamp-rail component, motion audit per §4 (emil review-format table), both themes.
- **W6 "landing page"** builds §7.
- Every future web implementer prompt carries the distilled §4/§6 rules inline; reviews cite this file by section.
