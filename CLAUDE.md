# Switchboard — Agent Operating Guide (CLAUDE.md)

> **You are building/maintaining Switchboard, an internal communication-first CRM.** The build followed `CLOSECLONE_BUILD_GUIDE` (the pasted spec). The living law is `CONTRACTS.md`; the design of the system is `ARCHITECTURE.md`. Read this file, then the run-state docs below.

---

## 0) Source-of-truth docs (these actually exist — read them, don't assume)

| Doc                                                  | Role                                                                                                                                                                                                    | You may edit?                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `ARCHITECTURE.md`                                    | System design: sync state machine, sequence scheduler, webhook paths, deploy topology.                                                                                                                  | Orchestrator only                                                     |
| `CONTRACTS.md`                                       | **Law.** Every cross-module fact: Drizzle schema, DSL grammar, activity taxonomy, sync state machine, the §4.3 never-events, REST/WS shapes, provider interfaces, error taxonomy. Currently **v1.3.0**. | Orchestrator only, **additive + versioned**, logged in `DECISIONS.md` |
| `DESIGN.md`                                          | Frontend visual identity ("Operator Grid"), tokens, motion law, craft bar.                                                                                                                              | Orchestrator only                                                     |
| `DECISIONS.md`                                       | Every autonomous judgment call, numbered (D-001…), with rationale. Append here.                                                                                                                         | Yes — append                                                          |
| `STATUS.md`                                          | Current phase, what's done, what remains.                                                                                                                                                               | Yes — keep current                                                    |
| `RECOVERY.md`                                        | Resume playbook after a disconnect/new session ("continue where we left off" = execute it).                                                                                                             | Yes — keep current                                                    |
| `HUMAN_TODO.md`                                      | Things only a human can do (accounts, legal sign-off, Docker host, GitHub Pages switch).                                                                                                                | Yes — append                                                          |
| `DEMO.md` / `DEPLOY-PREVIEW.md` / `deploy/WIRING.md` | Demo walkthrough, deploy-the-preview steps, production composition checklist.                                                                                                                           | Yes                                                                   |

There is **no** `REFERENCE.md` and **no** `BUILD_GUIDE.md` in this repo (an older CLAUDE.md referenced those — it was wrong). The ORM is **Drizzle**, not Prisma.

## 1) What this product is (one paragraph)

**Switchboard** is a communication-first CRM for our own sales team (internal, single-tenant, SSO-gated). The unit of work is the **conversation on a per-lead timeline**, not the record. Calls/emails/SMS/notes ingest into one append-only activity stream; **compliance rails** (consent, quiet hours, DNC, suppression, rate caps) are a **hard gate enforced in the engine layer on every outbound** — the API cannot bypass them. Smart Views (a small query DSL → parameterized SQL) and sequences drive daily work. Not marketing automation, not a help desk.

## 2) Stack & repo

- pnpm monorepo: `apps/api` (Fastify + Drizzle + Postgres; Redis/BullMQ behind a `QueueDriver`), `apps/web` (React + Vite; MSW for the mock/demo layer), `packages/shared` (zod contracts + the Smart View DSL compiler). Node 22 local (engine warning benign; CI/target is 24). `deploy/` and `e2e/` are standalone (outside the workspace).
- Tests: **Vitest**, DB tests on **PGlite** (embedded real Postgres, no Docker needed — see `DECISIONS.md` D-003); property tests for the compiler + the §4.3 never-events; Playwright E2E in `e2e/`. Latency gate is authoritative only on real Postgres in CI.
- All external I/O goes through four provider adapters (Email/Telephony/ASR/AI); `MOCK_MODE=1` swaps all of them + dev-login. No code above the adapter line branches on MOCK_MODE.

## 3) Current state (2026-07-16)

MVP is **built, merged, verified in-browser, and deployed** (GitHub Pages demo, mock data — see `STATUS.md`). Wave A readiness (SSO/RBAC, API tokens/webhooks, observability, deploy kit) is **merged** (~1,260 api tests). Remaining: Wave B (E2E + security review), Phase 3 real integrations (mock-first; real mode is HUMAN_TODO-gated on Twilio/Deepgram/Haiku accounts), final coherence pass. ~2,600 tests green.

## 4) Golden rules (read every time)

- **Compliance rails are non-negotiable and live in the engine layer.** Every send/dial checks suppression, DNC, window, cap, consent — re-checked _inside_ the send transaction (`apps/api/src/services/sequences/dispatch.ts`), never only at scheduling time. The internal API has no privileged bypass (I-RAIL-API).
- **`CONTRACTS.md` is the interface.** Additive changes only; bump the version and log the change in `DECISIONS.md` before/with the code. Never silently change a route, DTO, table, event, or error code.
- **Prove it or it isn't done.** Ship the acceptance tests. No green, no done. Verify user-facing changes in a real browser (mock mode) — green unit tests have hidden real breakage before (D-029).
- **No secrets in code or logs.** Env vars per `CONTRACTS.md`/`.env.example`. Tokens hashed (api) / encrypted at rest (oauth); logs redacted; secrets excluded from exports.
- **Determinism > cleverness.** The compliance engine and DSL compiler are pure and unit-tested. No `Math.random`/`Date.now` in seed/fixture logic.
- **Scope discipline.** Internal, single-tenant, US/Canada, English. No multi-tenancy, i18n, or marketing features.
- **Strict TypeScript.** No `any`/`@ts-ignore`/`TODO` in committed code.

## 5) Working protocol (orchestration)

This build runs as Fable (orchestrator, gatekeeper, contract owner) dispatching Opus `implementer` subagents, one module per task against a frozen contract, fenced to an allowlist, green-gated before commit. Parallel work runs in isolated git worktrees with shared-file fences; the orchestrator wires route/registry factories at merge. On a disconnect, execute `RECOVERY.md`. Keep `STATUS.md` / `DECISIONS.md` current and committed on `main`.

_Keep this file accurate. If it disagrees with the code, the code and `CONTRACTS.md` win — fix this file._
