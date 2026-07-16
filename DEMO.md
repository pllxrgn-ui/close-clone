# DEMO — Switchboard showcase walkthrough (~10 minutes)

Two ways to show it, and three acts. The shared **GitHub Pages URL** is the zero-setup demo (full UI, sample data). The **local real-engine** run is the "it's not a mockup" proof.

## Option 1 — the shared link (nothing to install)

**https://itguns.github.io/close-clone/welcome** — full product UI backed by synthetic sample data. Every surface and action works in the browser; a "Demo · sample data" chip in the top bar makes clear it's not live customer data. Open it, sign in with any dev-login user, and walk Act 1 below.

## Option 2 — local, against the real engine (2 terminals, ~30s)

```powershell
# Terminal 1 — the real engine: API on embedded Postgres + 5,000-lead dataset
pnpm --filter @switchboard/api run dev:mock
# wait for: [dev] listening on http://localhost:3000

# Terminal 2 — the web app pointed at the real API
$env:VITE_API_MODE = 'real'; pnpm --filter @switchboard/web dev
```

Open http://localhost:5173/welcome in a normal window, dark OS theme for full effect. (Leads/views/search/timeline run against the real engine here; the newer product surfaces — inbox, pipeline, sequences, reports, settings — are demoed on the shared link / default mock mode where their sample data lives.)

## Act 1 — the product (6 min)

1. **The front door** (`/welcome`): let the board ignite — grid etches in, six state lamps light in sequence, headline sets. Scroll the three feature acts (live components, not screenshots). "Every word and pixel is ours — not Close's."
2. **Sign in** → dev-login (stands in for company SSO — which is now built; see Act 3).
3. **The Inbox** (`/inbox`) — the rep's home: one lamp-lit queue of replies, overdue tasks, and sequence steps awaiting review. Press `R` to reply to the top row → send → the row leaves and the "Needs you now" counter drops. "The whole day is one keyboard-driven queue."
4. **The leads board** (`/leads`): thousands of rows, dense and instant. Color IS information — jade = new reply, amber = overdue, red = DNC. Select a few rows → the bulk bar: assign, set status, enroll, **export CSV**, set DNC — all live.
5. **Smart Views + the builder** (`/views/new`): build a filter visually, flip to the Raw DSL tab — same query both ways, round-trip guaranteed by property tests. It compiles to parameterized SQL.
6. **The Pipeline** (`/pipeline`): opportunities kanban, drag a card between stages → column sums recompute; currencies never cross-sum. Weighted pipeline in the header.
7. **Sequences** (`/sequences` → open Onboarding): the step ladder (with a "needs review" gate) and live enrollments — including a **Paused · reply** row. Point at the green callout: "A reply pauses everything — guaranteed at the database level, not by timing (I-SEND-2)." Click **Enroll**, pick a lead + contact → enrolled, count ticks.
8. **Reports** (`/reports`): rep activity with a bar chart, currency-aware funnel, sequence performance — switch the 7D/30D/90D range and watch it re-query.
9. **Settings → Compliance**: the switches that sell trust — "rails enforced by the engine on every send and dial; the app cannot bypass them," each tagged to its invariant (recording OFF/I-REC, unsubscribe/I-SEND-5, quiet hours/I-QUIET, daily cap/I-SEND-4).
10. **Keyboard-first throughout**: `Ctrl+K` palette opens in 0ms (used hundreds of times a day); `?` shows the full shortcut map; `J/K` walk any list.

## Act 2 — the engine (3 min, terminal beside the app)

11. **Scale**: `curl http://localhost:3000/api/v1/dev/ping` → 5,000 leads, 62,792 activities loaded in ~15s on a laptop; core reads in single-digit ms.
12. **The never-events** (the compliance spine): `pnpm --filter @switchboard/api exec vitest run src/services/sequences/send-safety.property.test.ts` — 15 adversarial properties proving a sequence email can never send twice (8–16 workers racing one claim), never after a reply (even one arriving _during_ the send), never to a suppressed/DNC address, never over the cap or outside the window. "These aren't features, they're proofs."
13. **Whole-suite proof**: ~2,600 tests green across api + web + shared, plus two phase gates with independent verification. CI runs it all on real Postgres + Redis on every push.

## Act 3 — production-readiness (1 min, if the boss asks "is it real?")

14. It's not just a demo skin. Already built and tested behind the UI: **OIDC SSO + group-based RBAC** (no passwords, ever — alg-confusion-proof JWT verification), **scoped API tokens + HMAC outbound webhooks + rate limits**, **append-only audit log + full data export**, **deep /healthz + structured logging with secret redaction**, and a **one-command Docker deploy with a scripted backup-restore drill**. Roadmap: real Twilio/Deepgram/Haiku (adapters ready, mock-proven), then the human checklist in `HUMAN_TODO.md` (accounts, legal sign-off on recording).

## If something breaks

- White page → hard-refresh (Ctrl+Shift+R); the Vite overlay tells the truth.
- Local API down → rerun Terminal 1; it rebuilds the world deterministically in ~15s.
- Simplest fallback: just use the shared Pages link — no backend, nothing to break.
