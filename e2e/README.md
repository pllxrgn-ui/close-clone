# Switchboard E2E (Playwright)

End-to-end tests that drive the **real web app** (`apps/web`) in **MOCK mode** — MSW
service worker + synthetic fixtures, **zero external accounts**. This is the
machine-verifiable coverage of the build guide §8 "full rep loop" and the key
surfaces.

The app is served as a production build (`vite build` → `vite preview`) on a fixed
port; in mock mode the bundle ships the MSW service worker
(`apps/web/public/mockServiceWorker.js`), so the static site answers the whole
REST surface from fixtures with no backend. Data is byte-deterministic (every
timestamp anchors to `REFERENCE_NOW = 2026-07-15T17:00:00Z`), so the asserted
ids/counts/numbers are stable.

## Why this lives outside the pnpm workspace

`e2e/` is **not** a `pnpm-workspace.yaml` member (same choice as `deploy/`). Its
heavy browser-test deps (`@playwright/test`, `playwright`) stay out of the
application dependency graph. Install/run it standalone with `--ignore-workspace`;
it has its own `pnpm-lock.yaml`. Because of this, the root `pnpm -r test` /
`pnpm --filter @switchboard/web test` vitest suites never pick these specs up.

## Running locally

```bash
# 1) one-time: install the Playwright browser (downloads chromium over the network)
pnpm --dir e2e install --ignore-workspace
pnpm --dir e2e exec playwright install chromium

# 2) run the suite (builds apps/web, serves it via vite preview, runs chromium)
pnpm --dir e2e test
```

- The `webServer` in `playwright.config.ts` builds `apps/web` then previews it on
  `http://127.0.0.1:4173` locally (one command, clean checkout works). In CI the
  dist is prebuilt by the workflow, so it previews only. `reuseExistingServer` is
  on locally, so if you already have a preview on `:4173` it is reused (no
  rebuild) — handy for fast iteration.
- **Browser download note:** `playwright install` fetches chromium (~180 MB) from
  `cdn.playwright.dev`. On a host without that network access the browser can't be
  installed and the suite can't run locally — that's expected; **CI installs and
  runs the browsers** (`.github/workflows/e2e.yml`).
- Useful: `pnpm --dir e2e test -- --ui` (interactive), `pnpm --dir e2e report`
  (open the last HTML report), `pnpm --dir e2e run typecheck`.

## What's covered

| Spec                   | Guide §8 step                | Asserts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rep-loop.spec.ts`     | 1–4 (the continuous journey) | `/welcome` ignition → **Open Switchboard** → dev-login → land in `/inbox`; open Leads → open a lead → **timeline renders**; open the **Email composer** → live merge-tag (`{{lead.name}}`) resolves in the preview → close; Inbox queue renders; **completing a task** removes its row and drops "Needs you now" (and lifts "Done today"); **a reply sends** and its row leaves.                                                                                                                                                                                      |
| `surfaces.spec.ts`     | 5–9 (the key surfaces)       | **Sequences:** step ladder (3 steps, "Needs review"), the **`Paused · reply`** enrollment (I-SEND-2), and **Enroll → roster count ticks +1**. **Pipeline:** board with the 5 stage columns + currency-separated sums + "Weighted" header + deal count. **Reports:** Activity/Funnel/Sequences tabs render numbers, and **switching the range re-queries** (Calls-logged 810 @30D → 189 @7D). **Settings → Compliance:** the invariant-tagged rails render (recording **Off**/I-REC, unsubscribe **On**/I-SEND-5, quiet-hours window/I-QUIET, daily cap 200/I-SEND-4). |
| `keyboard.spec.ts`     | 10                           | **Ctrl/Cmd+K** opens the command palette immediately, typing filters it, **Enter navigates**; **?** opens the shortcut sheet (Escape closes).                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `compliance.spec.ts`   | rails                        | The email composer on a **DNC lead** shows the do-not-contact block and **disables Send** — no override control (I-DNC / SUPPRESSED).                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `theme-motion.spec.ts` | themes + reduced motion      | Toggling the theme **persists across reload** (`<html data-theme>` + `sb-theme`); the app renders in **dark** color scheme; the app renders under **`prefers-reduced-motion: reduce`** (leads surface flags `data-reduced-motion="true"`).                                                                                                                                                                                                                                                                                                                            |
| `ai-confirm.spec.ts`   | AI confirm-before-commit     | See skip list below, plus a positive guard: the composer exposes **no AI write-path** (Send is the only commit).                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

`auth.setup.ts` is a Playwright **setup project**: it logs in once through the real
dev-login UI (as the admin fixture user **Ada Okafor**, so Settings is reachable)
and saves the authenticated `localStorage` as `storageState`. Every authed spec
reuses it; `rep-loop.spec.ts` opts out (`test.use({ storageState: … empty }`) so it
exercises the real welcome → login flow itself.

## Skip list (with reasons)

- **`ai-confirm.spec.ts` → "AI output requires an explicit user confirm before it
  writes"** — `test.skip`. As of this build there is **no AI affordance wired into
  the web UI**. The three AI paths in ARCHITECTURE §7 (call-summary draft note,
  email draft/rewrite, NL → Smart View) have no rendered control on any surface
  this suite drives (composer, inbox, pipeline, reports, sequences, settings were
  all verified free of AI/draft/rewrite/generate controls). There is no AI
  write-path to confirm end-to-end yet, so per task 5d the confirm-flow is skipped
  rather than fabricated. A passing guard test in the same file locks in that the
  composer's only backend write is the explicit **Send** button. Enable the skipped
  test once an AI affordance appears (assert: invoking AI must not mutate/send
  until the rep clicks a confirm control — I-AI: the confirming request carries
  `confirmedBy`).

## CI

`.github/workflows/e2e.yml` (separate from `ci.yml`) runs on push to `main` and on
PRs: installs deps, `playwright install --with-deps chromium`, builds the web app
(mock mode), runs the suite, and uploads the HTML report + traces as artifacts on
failure. Traces are captured `on-first-retry`.
