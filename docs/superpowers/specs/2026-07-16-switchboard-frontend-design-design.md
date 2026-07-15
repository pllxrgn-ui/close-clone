# Switchboard frontend design — spec (approved 2026-07-16)

**Decision trail:** user requested a commercial-grade UI distinct from Close plus a landing page → Close UI/UX teardown (landing formula, inbox-first loop, timeline spine, Smart Views as daily driver) → three direction boards published (artifact `switchboard-design-directions`) → user chose **A × C**, with Emil Kowalski (`emil-design-eng`) + `impeccable` standards governing taste and motion (both installed as user-level skills).

**Normative annex:** [DESIGN.md](../../../DESIGN.md) at the repo root is the design law — identity ("Operator Grid"), token tables (both themes, AA), type system (IBM Plex Sans Condensed / Inter / JetBrains Mono, self-hosted), motion law in two registers (product: nothing keyboard-initiated animates, <300ms, custom ease-out curves; landing: one 500–800ms board-ignition entrance, no scroll-fade carpet), craft bar, and landing page structure. This spec does not duplicate it.

## Scope

1. **W5 — Operator Grid re-skin + motion pass** over everything W1–W4 built: token rewrite, @fontsource self-hosting, LampRail state component, full motion audit reported in Emil's `| Where | Before | After | Rule |` format, both themes.
2. **W6 — landing page** at `/welcome` (unauthenticated product-grade front door): nav → board-ignition hero → three live-component feature acts → keyboard map as design object → compliance trust line → CTA. Live DOM vignettes, zero images, copy in operator's economy.
3. Every subsequent web task inherits the DESIGN_LAW block inline in its prompt (subagents cannot invoke skills); Fable invokes `emil-design-eng` / `impeccable-taste` during UI reviews.

## Non-goals

Email/sequence/inbox UI remains post-Gate-2 (guide §9). No marketing-site multipage build (single front door per user's "product-grade front door" choice). No Close visual assets, copy, or branding anywhere.

## Architecture

Identity is applied entirely at the token + component-skin layer; W1–W4 structure/behavior is direction-agnostic by design, so the re-skin is additive (tokens.css, primitives restyle, LampRail) and the motion audit edits transitions only. Landing is a lazy-loaded unauthenticated route reusing app primitives and MSW fixtures — no separate stack.

## Testing / acceptance

W5: full web suite green post-reskin, AA contrast table committed, motion audit table complete, axe smoke green both themes. W6: route tests including reduced-motion collapse + ignition replay guard; axe smoke; both themes. Vision review by orchestrator (screenshots vs DESIGN.md + §7) before merge — §5.3 of the build guide applies.

## Execution

Runs inside the existing `web-foundation` workflow (branch `web-foundation`, isolated worktree) as stages W5–W6 after W4 — queued 2026-07-16, dispatch on next workflow resume. Merge at Gate 2 with the rest of the stream.
