# ARCHITECTURE — Switchboard (internal communication-first CRM)

Normative companion: `CONTRACTS.md` (interfaces, grammar, invariants — law).
Stack per build guide §4.1: React+TS+Vite · Node+Fastify+TS · Postgres+Drizzle · Redis+BullMQ · OIDC · adapters for Email/Telephony/ASR/AI.

## 1. System diagram

```
                         ┌─────────────────────────────────────────────┐
                         │                 apps/web (Vite/React PWA)   │
                         │  Inbox · Lead page · Smart Views · Dialer   │
                         │  Command palette · Settings                 │
                         └───────────────┬─────────────┬───────────────┘
                                    REST │             │ WS (live inbox/timeline)
                         ┌───────────────▼─────────────▼───────────────┐
                         │              apps/api (Fastify)             │
                         │  auth (OIDC) · RBAC · REST · WS hub         │
                         │  webhook ingress (/wh/*) · internal API     │
                         └───┬─────────┬─────────┬─────────┬───────────┘
                             │         │         │         │
                     ┌───────▼──┐ ┌────▼────┐ ┌──▼──────┐ ┌▼─────────────┐
                     │ Postgres │ │  Redis  │ │ BullMQ  │ │ packages/    │
                     │ (truth)  │ │ (queues │ │ workers │ │ shared       │
                     │          │ │  only)  │ │         │ │ (types, DSL  │
                     └──────────┘ └─────────┘ └──┬──────┘ │  compiler)   │
                                                 │        └──────────────┘
                 ┌───────────────┬───────────────┼──────────────┬─────────────┐
          ┌──────▼─────┐  ┌──────▼──────┐  ┌─────▼─────┐  ┌─────▼─────┐  ┌────▼────┐
          │EmailProvider│ │Telephony    │  │ASRProvider│  │AIProvider │  │Webhook  │
          │ Gmail | Mock│ │ Twilio| Mock│  │Deepgram|Mk│  │Haiku | Mk │  │fan-out  │
          └────────────┘  └─────────────┘  └───────────┘  └───────────┘  └─────────┘
```

**Rules encoded in the shape:**
- Postgres is the *only* source of truth. Redis/BullMQ hold work, never state — every job is re-derivable from Postgres rows.
- All external I/O goes through the four provider adapters; `MOCK_MODE=1` swaps all of them (plus OIDC → dev-login stub) with zero code-path differences above the adapter line.
- Compliance rails (suppression, DNC, quiet hours, caps, recording consent) live in the **engine layer** (services called by both REST handlers and workers) — the API cannot bypass them because the API has no other path to a send/dial.
- The Smart View compiler lives in `packages/shared` and is the single query authority: builder UI, raw DSL editor, bulk actions, list dialer, and reporting all consume the same AST → SQL pipeline.

## 2. Monorepo layout

```
apps/
  web/            React+TS+Vite, PWA shell, keyboard-first
  api/            Fastify: routes/, services/, workers/, providers/, db/
packages/
  shared/         zod schemas + TS types (the contract), Smart View DSL
                  (lexer, parser, AST, SQL compiler), event taxonomy
fixtures/         5k golden dataset + 100k latency dataset generators,
                  recorded webhook fixtures (gmail push, twilio lifecycle)
deploy/           docker-compose.yml, Dockerfiles, backup/restore scripts
.github/workflows/ci.yml
```

## 3. The email sync state machine (per mailbox)

States (persisted in `mailbox_sync_state.status`):

```
UNLINKED → AUTHORIZING → BACKFILLING → LIVE ⇄ DEGRADED → REAUTH_REQUIRED
                                  └──────→ RESYNC (history id expired) → LIVE
```

- **AUTHORIZING**: OAuth in flight; nothing synced.
- **BACKFILLING**: full-history import via paged `messages.list`; checkpoint = `(pageToken, importedCount)` persisted per page so restart resumes, never restarts. On completion, records the mailbox's current `historyId` as the live-sync cursor. Messages arriving by push during backfill are processed normally — dedupe (unique `Message-ID` per mailbox) makes the race harmless.
- **LIVE**: push notification (or poll fallback timer) → enqueue `sync:pull` job → `history.list(startHistoryId=cursor)` → apply adds/label-changes in historyId order → advance cursor *in the same transaction* as the writes. Replays are no-ops by construction (dedupe + monotonic cursor).
- **RESYNC**: `history.list` returns 404/`historyId too old` → wipe nothing; re-run backfill in dedupe mode (only inserts unseen `Message-ID`s), then resume LIVE. Byte-identical state is preserved because inserts are deterministic and updates are idempotent upserts keyed on provider message id.
- **DEGRADED**: transient provider errors → exponential backoff, poll fallback; surfaces in admin UI.
- **REAUTH_REQUIRED**: refresh token revoked/expired → rep notified in-app; no data loss, cursor intact.

Every transition is written to the audit-relevant `sync_events` table with cause. Invariant (CONTRACTS §I-SYNC): *processing the same push/webhook/backfill page twice, in any order, yields identical rows.*

## 4. Sequence scheduler design

Two-layer design; **Postgres is authoritative, BullMQ is a wake-up call**:

1. **Rows:** enrolling a lead creates `sequence_enrollments` + one `send_intents` row per upcoming step (state `SCHEDULED`, unique key `(enrollment_id, step_id)`).
2. **Wake-ups:** a BullMQ delayed job per intent (plus a sweeper every minute that enqueues any due intent missing a job — self-heals lost jobs).
3. **The send transaction** (the only place a send can happen — CONTRACTS §I-SEND):
   ```
   BEGIN;
     UPDATE send_intents SET state='CLAIMED', claimed_at=now(), worker_id=$w
       WHERE id=$id AND state='SCHEDULED' AND due_at<=now()  -- claim or bail
       RETURNING *;                                          -- 0 rows → someone else has it / not due
     re-check IN THIS TXN: enrollment not paused/finished · no reply/bounce recorded ·
       recipient not suppressed · not DNC · inside window · under daily cap (advisory-locked counter);
     any check fails → state='SKIPPED' (reason) or 'BLOCKED', COMMIT, stop.
   COMMIT;                    -- claim visible before any network call
   → provider.send()          -- outside txn, with idempotency key = intent id
   → UPDATE state='SENT', provider_message_id=... (or 'FAILED' + retry policy)
   ```
   A crash between claim and send leaves `CLAIMED` rows that the sweeper expires to `FAILED_TIMEOUT` (never re-sent automatically without provider-side idempotency confirmation).
4. **Pauses:** inbound reply/bounce processing marks the enrollment paused *and* the transition is visible to any concurrent send transaction (row lock on enrollment) — closing the reply-vs-send race at the serialization level, not by timing.

## 5. Webhook ingestion paths

```
/wh/twilio/*   → signature verify (X-Twilio-Signature, reject ≠) → persist raw
                 payload (webhook_inbox) → 200 fast → worker processes → events
/wh/gmail      → Pub/Sub push JWT verify → persist → 200 → enqueue sync:pull
/wh/internal/* → (outbound to other systems) HMAC-signed, retried w/ backoff
```

All ingress is **persist-then-process** (transactional inbox): the HTTP handler only verifies, stores, and acks; workers consume `webhook_inbox` rows idempotently (unique provider event id). Replay of any webhook is therefore safe by the same argument as sync replay.

## 6. Realtime (WS)

Fastify WS hub; topics: `inbox:<userId>`, `lead:<leadId>`, `presence`. Writers publish after-commit via Postgres LISTEN/NOTIFY → hub fan-out. Clients treat WS as cache-invalidation hints and refetch through REST — no state is WS-only, so a dropped socket never loses data.

## 7. AI paths (Haiku 4.5, all confirm-before-commit)

- Call transcript → summary + action items → written as a **draft** note (`status='draft', author='ai'`); rep confirms → becomes timeline event. AI output *never* mutates records directly (CONTRACTS §I-AI).
- Email draft/rewrite → returned to composer, never auto-sent.
- NL → Smart View: Haiku emits DSL text; it is parsed by the *same* parser as user input — invalid DSL is a visible error, never a silent guess. Context sent to the provider is the minimum the feature needs (transcript, or thread excerpt, or schema-of-fields for NL search).

## 8. Deploy topology (Phase 5)

`docker compose up`: `api` (Node) · `web` (static via api or nginx) · `postgres` (+ WAL archiving to volume; nightly `pg_dump` + scripted restore drill) · `redis` · optional `glitchtip`. One container image for api+workers (role by env var). Fly.io private-app variant documented alongside. TLS terminated at the internal LB / Fly proxy; app speaks HTTP behind it. `/healthz` checks Postgres, Redis, queue depth, sync-lag; queue-depth + sync-lag alerts via structured logs → whatever the company scrapes.

## 9. Performance strategy (the 150ms p95 budget)

- Denormalized hot columns on `leads` maintained transactionally by the event writer: `last_contacted_at`, `last_inbound_at`, `next_task_due_at`, per-channel last-touch. Smart View activity predicates hit these first.
- Custom fields: JSONB column + GIN, with per-field expression indexes added by the field-definition service for `select`/`date`/`number` types (measured, not assumed).
- Keyset pagination everywhere; no OFFSET beyond page ~10.
- Timeline reads: `(lead_id, occurred_at DESC)` covering index; inbox reads: partial indexes on open items.
- The 100k fixture + `pnpm perf` harness is in CI from Phase 1 on; regressions fail the build.
