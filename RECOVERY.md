# RECOVERY — resume protocol after a disconnect / crash / new session

**Audience: the orchestrator (Claude).** When the user says anything like "continue where we left off", execute this file top to bottom. The orchestrator MUST keep this file current: update the stream table on every workflow launch, completion, or merge, and commit it.

## Ground truth

Git is the source of truth, not workflow state: **every task commits on green to its stream branch**, so `git log` per branch tells you exactly what finished. Workflow journals tell you what was *in flight*. Uncommitted files in a worktree = a task died mid-work (salvageable — see step 4).

Workflow scripts + journals live under the session dir:
`C:\Users\yatzv\.claude\projects\D--CODE-NEW-close-clone\<session-id>\workflows\scripts\*.js` and `...\subagents\workflows\<run-id>\journal.jsonl`
Scripts for session `fba7396e-b2e7-4e61-804f-d5c06e727c45` are the current ones (paths in the table below). These files persist on disk across sessions.

## Stream table (update me on every change)

| # | Stream | Worktree | Branch | Tasks | Run ID | Script file (session workflows\scripts\) | Status @ last update |
|---|---|---|---|---|---|---|---|
| 1 | Phase 2 email engine | `D:\CODE\NEW\close-clone` | `main` | 2a✅→2b→2c→2d→2e→2f | `wf_74b6bf62-c14` | `phase-2-email-engine-wf_74b6bf62-c14.js` | 2b running (salvage-amended) |
| 2 | Web foundation | `D:\CODE\NEW\close-clone-web` | `web-foundation` | W1→W2→W3→W4 | `wf_f5c002e0-3b2` | `web-foundation-wf_f5c002e0-3b2.js` | W1 running |
| 3 | Telephony mock 3a | `D:\CODE\NEW\close-clone-telephony` | `telephony-provider` | 3a | `wf_76086abe-24e` | `telephony-provider-3a-wf_76086abe-24e.js` | 3a running (2nd attempt) |
| 4 | CSV import 4f | `D:\CODE\NEW\close-clone-import` | `csv-import` | 4f | `wf_d7e0453f-638` | `csv-import-4f-wf_d7e0453f-638.js` | 4f running |
| 5 | Reporting 4g | `D:\CODE\NEW\close-clone-reports` | `reporting` | 4g | `wf_1134d3ca-1bd` | `reporting-4g-wf_1134d3ca-1bd.js` | 4g running |
| 6 | Admin ops 5b+5g | `D:\CODE\NEW\close-clone-admin` | `admin-ops` | 5b→5g | `wf_911cb476-226` | `admin-ops-5b-5g-wf_911cb476-226.js` | 5b running |

## Resume procedure

1. **Survey ground truth** (no assumptions): for each row above run `git -C <worktree> log --oneline -3` and `git -C <worktree> status --short`. Compare against the Tasks column → which tasks committed, which were in flight.
2. **Check journals**: `tail` each run's `journal.jsonl` — `{"type":"result",...}` lines are completed agents (their return values are cached); a bare `started` with no result = the agent died in flight.
3. **Same session** (workflow cache valid): relaunch each dead stream with
   `Workflow({scriptPath: "<script file>", resumeFromRunId: "<run id>"})` — completed agents replay from cache, the dead one re-runs. Stop a still-registered task first (`TaskStop <task id>`), if any.
4. **Salvage partial work**: if a worktree has uncommitted files from the dead agent, do NOT discard them — edit the script file first and prepend to the dead task's prompt: "A prior attempt died mid-task leaving uncommitted partial work (list from git status). Review with git diff; keep what's correct, finish or rewrite the rest; the tree must end green and committed." Then resume as in step 3. (Prompt edits invalidate only that task's cache — completed tasks still replay.)
5. **New session** (cache gone): the scripts still exist on disk. For each stream where git shows partially-completed task lists, EDIT the script to delete the already-committed tasks (keep `meta`, keep the REPORT schema, keep later tasks verbatim) and launch fresh with `Workflow({scriptPath})`. Never re-run a task whose commit already exists.
6. **Verify before declaring resumed**: `pnpm typecheck` at each active worktree root must be green (or the resumed agent's first job per its prompt). Update this file's Status column + STATUS.md, commit both.

## Standing orchestration rules (context for a fresh session)

- Model routing per build guide §2: Opus implements, Fable (orchestrator) gates — Gate 2 = idempotency + never-events, then merge order: telephony → web → import → reporting → admin-ops into main, wiring route-plugin factories + provider registry per each stream's `routeWiring`/`registryWiring` report field, full suite + UI vision review after each merge.
- Max-out parallelism policy (user-directed, D-017): keep every safe collision-free stream running; 6 is the current ceiling. Backfill from remaining backlog only post-Gate-2 (everything left depends on Phase 2 or on 5a auth).
- Shared-file fences for parallel streams: no edits to `routes/index.ts`, `server.ts`, provider registry, other streams' dirs; migrations use reserved numbers (Phase 2: 0003+, 4f: 0010, 5b: 0011).
- Run-state files (STATUS.md / DECISIONS.md / HUMAN_TODO.md / this file) are updated and committed by the orchestrator on `main` only.
