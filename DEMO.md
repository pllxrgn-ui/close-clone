# DEMO — Switchboard showcase walkthrough (~8 minutes)

Two acts: the product (looks + works), then the engine (the part competitors fake). Everything below runs on this machine with zero external accounts.

## Setup (2 terminals, ~30s)

```powershell
# Terminal 1 — the real engine: API on embedded Postgres + 5,000-lead dataset
pnpm --filter @switchboard/api run dev:mock
# wait for: [dev] listening on http://localhost:3000

# Terminal 2 — the web app in real-API mode
$env:VITE_API_MODE = 'real'; pnpm --filter @switchboard/web dev
```

Open http://localhost:5173/welcome — in a normal browser window, dark OS theme for full effect.

## Act 1 — the product (5 min)

1. **The front door** (`/welcome`): let the board ignite — grid etches in, six state lamps light in sequence, headline sets. Scroll the three feature acts (live components, not screenshots). Point out: "every word and pixel here is ours."
2. **Sign in** → dev-login (stands in for company SSO, which is the next phase).
3. **The leads board** (`/leads`): 5,000 real rows streaming from the API — dense, virtualized, instant. The color IS information: jade = new reply, amber = overdue, red = do-not-contact. "A glance reads like a status board."
4. **Smart Views** (sidebar): click *Overdue follow-ups*, then *High-value opportunities* — each is a saved query in our own DSL, compiled to SQL live by the engine. Open `/views/new`: build a filter visually, flip to the Raw DSL tab — same query both ways, round-trip guaranteed by 41 tests.
5. **Keyboard-first**: press `Ctrl+K` — palette opens in 0ms (deliberately — it's used hundreds of times a day). Type a lead name → Enter. Press `?` — the full shortcut map with the state legend. `J/K` walk rows.
6. **A lead page**: the timeline — every call, email, SMS, status change as one stream. "The timeline never lies: every touch exactly once, ordered, attributed."

## Act 2 — the engine (3 min, terminal beside the app)

7. **Scale**: `curl http://localhost:3000/api/v1/dev/ping` → 5,000 leads, 62,792 activities loaded in ~15s on a laptop, p95 reads measured in single-digit milliseconds.
8. **The never-events** (the compliance spine): run
   `pnpm --filter @switchboard/api exec vitest run src/services/sequences/send-safety.property.test.ts`
   — 15 adversarial properties proving: a sequence email can never send twice (8–16 workers racing one claim), never after a reply (even one arriving *during* the send), never to a suppressed or DNC address, never over the daily cap, never outside the window. "These aren't features, they're proofs — 917 tests total."
9. **Real import**: show `POST /api/v1/imports` → dry-run → commit on a 10k-row CSV (36s, exact dedupe report) if asked about migration.
10. **Close**: architecture slide is [ARCHITECTURE.md](ARCHITECTURE.md) §1; roadmap = Phase 3 telephony (mock already proven against Twilio's own signature vectors), inbox UI, SSO, deploy. Shareable preview: the Vercel URL (`/welcome`) in demo-data mode.

## If something breaks

- White page → hard-refresh (Ctrl+Shift+R); Vite dev overlay tells the truth.
- API down → rerun Terminal 1; it rebuilds the world deterministically in ~15s.
- Fallback mode with zero backend: stop Terminal 1, restart Terminal 2 **without** `VITE_API_MODE` — same UI on canned data.
