# STATUS — Switchboard build

**Phase:** 0 — Planning & foundation (in progress)
**Orchestrator:** Fable 5 · **Implementers:** Opus 4.8 subagents · **Mode:** MOCK_MODE-first (no external accounts present)

## The three constraints most likely to break this build, and the de-risk plan

1. **Gmail sync idempotency under history-id semantics.** Gmail's `history.list` is a leaky abstraction: history ids expire (404 → forced full resync), pushes coalesce and arrive out of order, and a full-history import can race a live push for the same message. If replaying any input doesn't yield byte-identical CRM state, the timeline lies and trust is gone.
   *De-risk:* the sync engine is specced as an explicit state machine in CONTRACTS.md before any Gmail code exists; `MockEmailProvider` implements the *same history semantics* (ids, coalescing, expiry) so idempotency is property-tested in CI against replays and reorderings, not discovered in production. Dedupe key is RFC 5322 `Message-ID`, enforced by a DB unique constraint — the database, not worker discipline, is the last line of defense.

2. **Sequence send races (the never-events).** "Reply arrived one second before the send fired" and "two workers claim the same step" are the two interleavings that turn a CRM into a spam cannon. Queue-level checks are insufficient because BullMQ is not the source of truth.
   *De-risk:* send intents are rows in Postgres claimed with a transactional unique-key insert; pause/suppression/window/cap conditions are re-checked *inside the claiming transaction*, not at scheduling time. An adversarial-interleaving property suite (2f) is a phase-gate blocker: product surface work does not start until it is green.

3. **Smart View latency at 100k leads.** The DSL invites cross-table predicates (`has_call within 30d`, custom-field filters) that naively compile to correlated subqueries and blow the 150ms p95 budget; discovering this in Phase 4 would force a query-engine rewrite under a finished UI.
   *De-risk:* the 100k-lead fixture generator ships in Phase 0c; index strategy is a named deliverable (1c) with latency *measured in CI* against the fixture, gated before Phase 2 starts. Activity predicates compile to indexed denormalized columns (`last_contacted_at`, per-channel last-touch) maintained by the event stream, falling back to EXISTS subqueries only where measured safe.

## Task board

| Task | Owner | State |
|---|---|---|
| 0-kickoff: repo, run-state files | Fable | done |
| 0a ARCHITECTURE.md | Fable | done |
| 0b CONTRACTS.md | Fable | done (v1.0.0) |
| 0c scaffold, CI, fixtures, implementer agent | Opus | dispatched, in progress |
| Phase 1 (1a–1e) + gate | — | pending |
| Phase 2 (2a–2f) + gate | — | pending |
| Phase 3 (3a–3g) | — | pending |
| Phase 4 (4a–4i) | — | pending |
| Phase 5 (5a–5h) + final coherence pass | — | pending |

## Spend vs. §2 split
Fable spend so far: kickoff + planning artifacts only. Target ≤ 25% Fable share, expected 10–15%.

## Environment notes
- Host is Windows 11 (not the Linux container the guide assumes). Node 24.14, pnpm 10.31, git 2.53 present. **Docker and `gh` CLI absent** → Docker-dependent verification (compose up, CI-parity Postgres/Redis) is a HUMAN_TODO item; tests will run against embedded/in-memory fallbacks (pg-mem is *not* acceptable for the latency gate — see DECISIONS.md D-003).
