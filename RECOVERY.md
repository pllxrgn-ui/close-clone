# RECOVERY — resume protocol after a disconnect / crash / new session

**Audience: the orchestrator (Claude).** When the user says anything like "continue where we left off", execute this file top to bottom. The orchestrator MUST keep this file current: update the stream table on every workflow launch, completion, or merge, and commit it.

## Ground truth

Git is the source of truth, not workflow state: **every task commits on green to its stream branch**, so `git log` per branch tells you exactly what finished. Workflow journals tell you what was *in flight*. Uncommitted files in a worktree = a task died mid-work (salvageable — see step 4).

Workflow scripts + journals live under the session dir:
`C:\Users\yatzv\.claude\projects\D--CODE-NEW-close-clone\<session-id>\workflows\scripts\*.js` and `...\subagents\workflows\<run-id>\journal.jsonl`
Scripts for session `fba7396e-b2e7-4e61-804f-d5c06e727c45` are the current ones (paths in the table below). These files persist on disk across sessions.

## Stream table (update me on every change)

| # | Stream | Worktree | Branch | Tasks | Run ID | Script file (session workflows\scripts\) | Status @ last update (2026-07-16 ~00:10) |
|---|---|---|---|---|---|---|---|
| 1 | Phase 2 email engine | `D:\CODE\NEW\close-clone` | `main` | 2a✅→2b→2c→2d→2e→2f | `wf_74b6bf62-c14` | `phase-2-email-engine-wf_74b6bf62-c14.js` | 2b running, 3rd attempt (salvaging ~1h of gmail+sync work) |
| 2 | Web foundation | `D:\CODE\NEW\close-clone-web` | `web-foundation` | W1→W2→W3→W4 | `wf_f5c002e0-3b2` | `web-foundation-wf_f5c002e0-3b2.js` | W1 running, 2nd attempt (deps salvaged) |
| 3 | Telephony mock 3a | `D:\CODE\NEW\close-clone-telephony` | `telephony-provider` | 3a ✅ | `wf_76086abe-24e` | `telephony-provider-3a-wf_76086abe-24e.js` | **COMPLETE + QA'd 07-16 ~03:10** (Fable re-ran 310 api tests green; diff review PASS — signature scheme/constant-time verified, providers.ts append-only). unsureAbout verdicts: fixture dir → move to fixtures/webhooks/twilio at merge; eventId synthesis fine (ingress decides key); signed-URL-base note goes into the 3b prompt. **Merge notes:** registryWiring steps in report (exactOptionalPropertyTypes spreads!); adjudicate fixtures/twilio → fixtures/webhooks/twilio move; 3b must verify signatures against the real configured webhook base |
| 4 | CSV import 4f | `D:\CODE\NEW\close-clone-import` | `csv-import` | 4f | `wf_d7e0453f-638` | `csv-import-4f-wf_d7e0453f-638.js` | 4f running (alive @22:23) |
| 5 | Reporting 4g | `D:\CODE\NEW\close-clone-reports` | `reporting` | 4g ✅ | `wf_1134d3ca-1bd` | `reporting-4g-wf_1134d3ca-1bd.js` | **COMPLETE + QA'd 07-16 ~02:00** (I re-ran 316 tests green; diff review clean — sql.raw constants-only verdict PASS; friction parked in STATUS.md) |
| 6 | Admin ops 5b+5g | `D:\CODE\NEW\close-clone-admin` | `admin-ops` | 5b ✅ → 5g | `wf_911cb476-226` | `admin-ops-5b-5g-wf_911cb476-226.js` | 5b COMPLETE (1a77c13; QA pending merge-time). 5g running, 2nd attempt (cli/export/routes salvaged). **Merge notes:** interleave migrations 0004–0010 into _journal before 0011 + re-chain 0011_snapshot prevId; thread adminGuard into RouteDeps; suppressions route must call releaseSuppression() |

**Known failure mode:** this host's connection drops roughly hourly (ECONNRESET/ENOTFOUND kill in-flight agents; observed ~20:30, ~22:10, ~23:55 on 2026-07-15 — 7 agent deaths total; every stream is on attempt 2–4 but no committed work has ever been lost). All re-dispatched prompts now carry an incremental-commit rule (commit every green milestone, never >30 min uncommitted). Some deaths are SILENT (the workflow task vanishes without a completion notification — happened to web W1): detect them with the liveness probe below.

**Liveness probe** (an alive agent's transcript grows continuously):
`ls -la --time-style=+%H:%M "<transcript dir>"/agent-*.jsonl` — mtime older than ~15 min ⇒ presumed dead ⇒ TaskStop (if registered), salvage-amend, resume.

## Resume procedure

1. **Survey ground truth** (no assumptions): for each row above run `git -C <worktree> log --oneline -3` and `git -C <worktree> status --short`. Compare against the Tasks column → which tasks committed, which were in flight.
2. **Check journals**: `tail` each run's `journal.jsonl` — `{"type":"result",...}` lines are completed agents (their return values are cached); a bare `started` with no result = the agent died in flight.
3. **Same session** (workflow cache valid): relaunch each dead stream with
   `Workflow({scriptPath: "<script file>", resumeFromRunId: "<run id>"})` — completed agents replay from cache, the dead one re-runs. Stop a still-registered task first (`TaskStop <task id>`), if any.
4. **Salvage partial work**: if a worktree has uncommitted files from the dead agent, do NOT discard them — edit the script file first and prepend to the dead task's prompt: "A prior attempt died mid-task leaving uncommitted partial work (list from git status). Review with git diff; keep what's correct, finish or rewrite the rest; the tree must end green and committed." Then resume as in step 3. (Prompt edits invalidate only that task's cache — completed tasks still replay.)
5. **New session** (cache gone): the scripts still exist on disk. For each stream where git shows partially-completed task lists, EDIT the script to delete the already-committed tasks (keep `meta`, keep the REPORT schema, keep later tasks verbatim) and launch fresh with `Workflow({scriptPath})`. Never re-run a task whose commit already exists.
6. **Verify before declaring resumed**: `pnpm typecheck` at each active worktree root must be green (or the resumed agent's first job per its prompt). Update this file's Status column + STATUS.md, commit both.

## Overnight autonomous protocol (user-directed 2026-07-16, ~01:50: "review test QA everything bone dry, plan then fix, prioritize skills, appropriate model")

Runs unattended on every task-notification plus an hourly heartbeat cron (session job `80c9c07d`, hourly at :23). Never ask the user; decisions go to DECISIONS.md.

**On every stream completion — the QA loop (Fable runs it):**
1. **Verify with evidence, not reports** (verification-before-completion skill): in that stream's worktree run `pnpm typecheck` + the full affected package suites yourself; the agent's claim counts for nothing until the commands pass in front of you.
2. **Review the branch diff bone-dry**: `git diff main...<branch>` reviewed against CONTRACTS.md clause by clause (and DESIGN.md for web work — invoke emil-design-eng + impeccable-taste for any UI/motion review; use the code-review skill's discipline: cite file, line, and the contract clause violated). Check the report's unsureAbout/contractFriction items explicitly — each one gets a verdict.
3. **Problems found → plan → fix**: write the defect list, then dispatch ONE Opus fix task per coherent defect group into the same worktree/branch (implementer agent, allowlist scoped to the defective module, fix + regression test required). Two Opus strikes on the same defect → Fable fixes it directly. Re-run step 1 after fixes.
4. **Close out**: mark the stream ✅ in the table above, update STATUS.md, commit run-state on main.

**Pipeline advancement (in priority order):**
1. Phase 2 chain (2c→2f) — the build's spine; on chain completion run **GATE 2** (I-SYNC replay/shuffle/dupe proofs + all I-SEND-* under adversarial interleavings + rail-bypass attempts), and only after the gate: the merge train.
2. **Merge train** (after Gate 2): telephony → web → import → reporting → admin-ops into main; apply each report's routeWiring/registryWiring; regenerate lockfile; full monorepo suite green after EACH merge; contract friction adjudicated with CONTRACTS version bumps logged in DECISIONS.md.
3. Post-merge: wire the **PGlite dev server** (real API + 5k fixture + MOCK_MODE, no Docker) so the product runs locally; then vision-review the web app + landing against DESIGN.md via the in-app browser with screenshots.
4. Web chain: when the running workflow ends (old script ends after W4), resume immediately — W1–W4 replay cached, W5 (Operator Grid re-skin) + W6 (landing) run live.
5. No new backfill streams overnight — everything left in the backlog depends on Phase 2 output or 5a auth (D-017).

**Model routing overnight:** all implementation/fixes = Opus (implementer agent); review judgment, gates, merges, contract amendments = Fable (main loop). Skills in play: verification-before-completion (before any ✅), systematic-debugging (any non-obvious failure), code-review discipline (diff reviews), emil-design-eng + impeccable-taste (UI/motion QA), brainstorming HARD-GATE does not apply to fixes (design already approved).

## Standing orchestration rules (context for a fresh session)

- Model routing per build guide §2: Opus implements, Fable (orchestrator) gates — Gate 2 = idempotency + never-events, then merge order: telephony → web → import → reporting → admin-ops into main, wiring route-plugin factories + provider registry per each stream's `routeWiring`/`registryWiring` report field, full suite + UI vision review after each merge.
- Max-out parallelism policy (user-directed, D-017): keep every safe collision-free stream running; 6 is the current ceiling. Backfill from remaining backlog only post-Gate-2 (everything left depends on Phase 2 or on 5a auth).
- Shared-file fences for parallel streams: no edits to `routes/index.ts`, `server.ts`, provider registry, other streams' dirs; migrations use reserved numbers (Phase 2: 0003+, 4f: 0010, 5b: 0011).
- Run-state files (STATUS.md / DECISIONS.md / HUMAN_TODO.md / this file) are updated and committed by the orchestrator on `main` only.
