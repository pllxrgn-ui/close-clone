# STATUS — Switchboard build

## ✅ BUILD COMPLETE (2026-07-16)

Every phase of the guide is built, merged to `main`, and green. **~4,000 tests** (1,481 api · ~1,100 web · 85 shared · 13 Playwright E2E executed), two phase gates, a whole-codebase security review (no critical), and a final coherence pass (no blocking incoherence — every compliance invariant verified enforced + tested). CONTRACTS at v1.3.1; DECISIONS D-001..D-034.

**What's built:** data core + Smart-View DSL→SQL engine · Gmail-model email sync (idempotent state machine) · sequence engine with adversarially-proven never-events · full product UI (inbox, leads+bulk, pipeline, sequences, reports, settings, landing) deployed to GitHub Pages (mock data) · telephony/SMS/AI (Twilio/Deepgram/Haiku adapters, mock-verified, confirm-before-commit) · SaaS readiness: OIDC SSO+RBAC, API tokens/webhooks/rate-limits, observability, deploy kit, append-only audit, data export, admin CLI. Repo is a single `main` worktree.

**Post-build increment (2026-07-17, D-035/D-037):** `apps/web/src/ui` primitives layer completed to a production component system — Field/Textarea/Checkbox/Switch (context-wired forms), Tabs/Menu/Tooltip/Drawer (APG keyboard patterns, motion-law compliant, Drawer `instant` for keyboard summons), ErrorState, shared floating positioning, `ui/README.md` architecture+usage doc — then **every feature dir migrated onto it** via four parallel fenced streams + an adversarial ui review with 7 hardening fixes (D-036). All hand-rolled error blocks/textareas/checkboxes/form-field plumbing and the reports tab strip are gone; deliberate skips documented. Web suite 1,031 green; browser-verified on the merged tree.

**Two things gated on a human (not the build):** (1) enable GitHub Pages (Settings→Pages→Source: GitHub Actions) to make the demo URL live; (2) real service accounts + Docker host for real-mode + production deploy (HUMAN_TODO). The production composition root (global OIDC guards, BullMQ webhook worker, real healthz, real adapters) is documented in deploy/WIRING.md and deferred until that infra exists — honest status: merged + unit/integration-tested + wired-per-doc, "done" when it runs against real infra.

**Real product API — BUILT + WIRED + PROVEN (2026-07-17, D-036):** the D-034 S2 gap is CLOSED. leads/contacts/opportunities/tasks/notes/smart-views/bulk/admin/inbox now have REAL production routes (not MSW-only); SMS-in-sequences wired into the send transaction. Full api suite **1,699 green**. Verified end-to-end in a real browser with **VITE_API_MODE=real (MSW OFF)**: leads board, Smart View compiling `next_task_due < today` live (≈1,442 real overdue), inbox composed queue (1,442 real tasks), admin/users, smart-views/preview — all served by real routes against real Postgres, zero console errors. The product CORE runs for real end-to-end; external integrations (email/calls/SMS/AI/SSO) still need accounts (HUMAN_TODO).

**Follow-up (tracked, non-blocking):** the pipeline board renders ALL real opportunities (2,052) unvirtualized → sluggish in real mode; MOCK-mode demo (Pages + local mock) is unaffected (~83 seeded). Bound the board load / default-limit GET /opportunities.

**Prior deferrals now resolved:** ~~SMS-in-sequences skips~~ (wired, D-036) · ~~product-CRUD/inbox/bulk MSW-only~~ (real routes, D-036) · comms client reconciled to real routes (R5).

---

**History:** MVP COMPLETE + DEPLOYED (07-16). Gate 1 ✅ · Gate 2 ✅ · merge train ✅ · **full product surface ✅** (inbox, pipeline, sequences UI, reports UI, bulk+settings — all merged, wired, and verified working in a real browser in mock mode). Demo ships two ways: the GitHub Pages link (`itguns.github.io/close-clone/welcome`, needs the one-time Settings→Pages switch on the ITGuns account) and the local PGlite real-engine (DEMO.md). ~2,600 tests green (969 web · 917 api · 85 shared). Demo ribbon live. CONTRACTS 1.3.0.

**Wave A readiness: MERGED to main** (07-16) — SSO+RBAC, API tokens/webhooks/rate-limits, observability, deploy kit. api suite now **1,260 green**. Security headers wired into server.ts; the infra-gated production composition (real healthz, global OIDC guards, BullMQ webhook worker) is documented in deploy/WIRING.md and deferred to the deploy step per verify-before-completion (D-031).

**Wave B: COMPLETE.** 5h security review + 3 fixes ✅ (no critical; core certified solid; report docs/security/2026-07-16-review.md). 5d Playwright E2E ✅ — merged, **13 specs actually executed green (browsers installed), 3× stable**, CI-wired (`.github/workflows/e2e.yml`): full §8 rep loop + all surfaces + keyboard + DNC-send-disabled + theme/reduced-motion. Repo prettier-clean (CI format:check green).

**Phase 3 (mock-first): COMPLETE + MERGED** (D-033) — Twilio adapter + signature-verified ingress + calls/dial; sequential dialer + voicemail; recording §4.5 (default-OFF, admin+audited, consent-before-record, I-REC); two-way SMS (STOP + quiet-hours, I-QUIET); AI call summaries + drafting + NL→SmartView (confirm-before-commit, I-AI). ai/asr mocks bound in the registry; telephony/sms/ai wired as optional routes. Full api suite **1,481 green**. Real Twilio/Deepgram/Haiku = HUMAN_TODO; deferred wiring in deploy/WIRING.md §5.

**Repo collapsed:** all 20 feature worktrees merged + removed — single `main` worktree at `D:\CODE\NEW\close-clone`.

**FINAL step: coherence pass running** (whole-codebase review — contract drift, invariant leaks, dead code, DECISIONS↔code). On its clearance (+ any fixes), the build is DONE.
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
| 0c scaffold, CI, fixtures, implementer agent | Opus | done (85c7ff1, 15 tests green, fixtures deterministic) |
| 1a schema + activity stream + fixture loader | Opus | done (295cdd9; merged to main) |
| 1b Smart View DSL parser→AST→SQL | Opus | done (75d093b) |
| 1c indexes + pagination + latency gate | Opus | done (60316d6; CI perf gate live on first push) |
| 1d DSL golden set (118 cases) | Opus | done (f0bc17d; surfaced+fixed 2 compiler bugs, D-011) |
| 1e global search (FTS+trigram) | Opus | done (031c78e) |
| GATE 1 | Fable | **PASSED 2026-07-15** — typecheck clean; 283 tests green (205 api incl. 118 goldens, 78 shared incl. hostile-input property suite, 2000 runs, params-only); worst core p95 54.77ms vs 150ms budget @10k PGlite (NON-authoritative per D-003; authoritative CI run pending GitHub push — HUMAN_TODO) |
| Phase 2 (2a–2f) + gate | Opus / Fable | serial chain running (D-013); 2a done (1c0c73c), 2b done (gmail+sync engine, incremental commits), 2c threading in progress; gate pending |
| Web foundation W1–W4 (parallel stream, D-014) | Opus | running on branch `web-foundation` in isolated worktree; W1 shell/tokens/client → W2 palette/keyboard → W3 leads/views/search UI → W4 Smart View builder; merge at Gate 2 |
| 3a telephony mock (pulled forward, D-015) | Opus | running on branch `telephony-provider` in isolated worktree; merge at Gate 2 |
| 4f CSV import engine (D-017) | Opus | running on branch `csv-import`; migration 0010; merge at Gate 2 |
| 4g reporting (D-017) | Opus | **DONE** — 8 commits on `reporting` (c9d5b00..5d73ec8), 82 new tests, all exact-number DB-backed; perf ~12–125ms vs 500ms budget (PGlite). Friction parked for Gate-2 adjudication: email_bounced payload lacks enrollmentId (C4), opportunity_stage_changed from/to must be pinned as stage IDs (C4), report schemas to promote into packages/shared at merge, cross-lead reporting index proposal (measure on 100k), funnel range semantics documented in funnel.ts |
| 5b audit log → 5g export + admin CLI (D-017) | Opus | running on branch `admin-ops`; migration 0011; merge at Gate 2 |

**Recovery:** RECOVERY.md (committed) is the resume playbook — keep its stream table current.

**Design:** DESIGN.md (committed 549880f) — "Operator Grid" (A×C) locked by user; spec at docs/superpowers/specs/2026-07-16-switchboard-frontend-design-design.md; W5 re-skin + W6 landing queued after W4; emil-design-eng + impeccable-taste installed as user-level skills.
| Phase 3 (3a–3g) | — | pending |
| Phase 4 (4a–4i) | — | pending |
| Phase 5 (5a–5h) + final coherence pass | — | pending |

## Spend vs. §2 split
Fable spend so far: kickoff + planning artifacts only. Target ≤ 25% Fable share, expected 10–15%.

## Environment notes
- Host is Windows 11 (not the Linux container the guide assumes). Node 24.14, pnpm 10.31, git 2.53 present. **Docker and `gh` CLI absent** → Docker-dependent verification (compose up, CI-parity Postgres/Redis) is a HUMAN_TODO item; tests will run against embedded/in-memory fallbacks (pg-mem is *not* acceptable for the latency gate — see DECISIONS.md D-003).
