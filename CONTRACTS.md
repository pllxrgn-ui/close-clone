# CONTRACTS — Switchboard (normative; Opus may not amend — report friction upward)

Version: 1.0.1. Changes only by Fable; every change bumps this version and is logged in DECISIONS.md.
All types live in `packages/shared/src/` as zod schemas with inferred TS types. Zod schema = runtime contract; the TS type is derived, never hand-written separately.

---

## C1. Domain model (Drizzle schema, normative shape)

Conventions: PKs `id uuid default gen_random_uuid()` · timestamps `timestamptz` · soft delete only where stated · every table has `created_at`/`updated_at` · FKs `on delete restrict` unless stated.

```
users            id, email (unique, citext), name, role ('rep'|'admin'), idp_subject (unique),
                 is_active bool, timezone text
leads            id, name, url, description, status_id → lead_statuses, owner_id → users,
                 custom jsonb not null default '{}',
                 -- denormalized hot columns (event-writer maintained, CONTRACTS C4):
                 last_contacted_at, last_inbound_at, next_task_due_at,
                 last_call_at, last_email_at, last_sms_at,
                 dnc bool not null default false,
                 search_tsv tsvector (generated), deleted_at (soft)
lead_statuses    id, label, sort_order                    -- e.g. Potential/Contacted/Qualified/Won/Lost
contacts         id, lead_id → leads, name, title, emails jsonb [{email,type}], phones jsonb
                 [{phone,type}], dnc bool default false, deleted_at (soft)
opportunities    id, lead_id, contact_id?, value_cents bigint, currency char(3) default 'USD',
                 stage_id → opportunity_stages, confidence int 0..100, close_date date,
                 owner_id, status ('active'|'won'|'lost'), note text
opportunity_stages id, label, sort_order
custom_field_defs id, entity ('lead'|'contact'|'opportunity'), key (unique per entity, snake_case),
                 label, type ('text'|'number'|'date'|'select'|'user'), options jsonb?, required bool
activities       -- THE spine. Append-only. No UPDATE except denoted mutable columns.
                 id, lead_id (indexed w/ occurred_at desc), contact_id?, user_id?,
                 type (see C4 taxonomy), occurred_at timestamptz, payload jsonb (typed per C4),
                 -- mutable columns: none. Corrections are new events (type='activity_correction').
tasks            id, lead_id, assignee_id, title, due_at, completed_at?, created_by
notes            id, lead_id, author_id, body_md, status ('draft'|'final'), ai_generated bool
email_accounts   id, user_id, address citext, provider ('gmail'|'mock'), oauth_tokens (encrypted),
                 sync_status (C5 states), history_cursor text?, backfill_checkpoint jsonb?,
                 daily_send_count int, daily_count_date date
email_messages   id, account_id, provider_message_id (unique per account), rfc_message_id text,
                 thread_id → email_threads, direction ('in'|'out'), from_addr, to_addrs jsonb,
                 cc jsonb, subject, snippet, body_ref, sent_at, in_reply_to text?, refs jsonb,
                 UNIQUE (account_id, rfc_message_id)          -- the dedupe backstop
email_threads    id, lead_id?, subject_norm, participants jsonb, triage_status
                 ('matched'|'ambiguous'|'ignored'), provider_thread_id?
sequences        id, name, status ('active'|'archived'), settings jsonb (window, cap override?)
sequence_steps   id, sequence_id, sort_order, type ('email'|'call_task'|'sms'), delay_hours int,
                 template_id?, requires_review bool default false, condition jsonb?
sequence_enrollments id, sequence_id, lead_id, contact_id, email_account_id, enrolled_by,
                 state ('active'|'paused'|'finished'|'unenrolled'), paused_reason?
                 UNIQUE (sequence_id, contact_id) WHERE state IN ('active','paused')
send_intents     id, enrollment_id, step_id, channel, due_at, state
                 ('SCHEDULED'|'CLAIMED'|'SENT'|'SKIPPED'|'BLOCKED'|'FAILED'|'FAILED_TIMEOUT'
                  |'AWAITING_REVIEW'),
                 claimed_at?, worker_id?, sent_at?, provider_message_id?, skip_reason?,
                 UNIQUE (enrollment_id, step_id)               -- never-sends-twice backstop
suppressions     id, kind ('email'|'phone'), value citext/text (unique per kind), source
                 ('unsubscribe'|'bounce'|'stop_keyword'|'manual'|'import'), reason?, created_by?,
                 released_at?, released_by?, release_reason?   -- release = admin + audit only
templates        id, name, channel ('email'|'sms'), subject?, body, owner_id?, shared bool
snippets         id, shortcut, body, owner_id
calls            id, lead_id, contact_id?, user_id, direction, twilio_sid (unique)?, status
                 ('queued'|'ringing'|'answered'|'completed'|'failed'|'voicemail'|'missed'),
                 duration_s?, outcome?, recording_ref?, transcript_ref?, started_at, ended_at?
sms_messages     id, lead_id, contact_id?, user_id?, direction, from_number, to_number, body,
                 provider_sid (unique)?, status, sent_at
smart_views      id, name, owner_id, shared bool, dsl text, ast jsonb, sort jsonb, columns jsonb
webhook_inbox    id, provider ('twilio'|'gmail'), provider_event_id (unique per provider),
                 raw jsonb, received_at, processed_at?, error?
webhook_subscriptions id, url, secret, events jsonb, is_active     -- outbound
webhook_deliveries id, subscription_id, event jsonb, state, attempts, next_retry_at?
api_tokens       id, name, hash (sha256, never plaintext), scopes jsonb, created_by, last_used_at?,
                 revoked_at?
audit_log        append-only: id, actor_id?, actor_type ('user'|'system'|'api_token'),
                 action, entity, entity_id?, before jsonb?, after jsonb?, reason?, ip?, at
org_settings     singleton row: recording_enabled bool default false, recording_enabled_by?,
                 recording_legal_signoff_ref?, quiet_hours jsonb, sending_window jsonb,
                 daily_send_cap int default 200, company_timezone text
sync_events      id, account_id, from_state, to_state, cause, at
```

## C2. Provider interfaces (all in `packages/shared/src/providers.ts`)

```ts
interface EmailProvider {
  getAuthUrl(accountHint: string, redirectUri: string): Promise<string>;
  exchangeCode(code: string, redirectUri: string): Promise<OAuthTokens>;
  listHistory(tokens, cursor: string): Promise<HistoryPage>;         // throws HistoryExpiredError
  listMessages(tokens, pageToken?): Promise<MessagePage>;            // backfill
  getMessage(tokens, providerMessageId): Promise<RawEmail>;
  send(tokens, draft: OutboundEmail, idempotencyKey: string): Promise<{providerMessageId, rfcMessageId}>;
  watch(tokens, callbackUrl): Promise<{expiresAt}>;                  // push subscription
}
interface TelephonyProvider {
  createCallToken(userId): Promise<BrowserCallToken>;
  dial(from, to, opts: {record: boolean, consentAnnouncement: boolean}): Promise<{callSid}>;
  sendSms(from, to, body, idempotencyKey): Promise<{sid}>;
  verifyWebhook(headers, rawBody, url): boolean;                      // MUST be used on every ingress
  dropVoicemail(callSid, recordingRef): Promise<void>;
}
interface ASRProvider { transcribe(audioRef): Promise<Transcript>; }
interface AIProvider {
  summarizeCall(transcript, ctx): Promise<{summary, actionItems: string[]}>;
  draftEmail(instruction, threadCtx): Promise<{subject?, body}>;
  nlToSmartView(query, fieldCatalog): Promise<{dsl: string}>;         // output MUST be re-parsed
}
```

Mocks implement the same interfaces with fixture scripting hooks (`MockEmailProvider.injectIncoming(email, atHistoryId)`, `MockTelephonyProvider.scriptLifecycle(callSid, events[])`). `MOCK_MODE=1` binds all four + dev-login. No conditional logic above the adapter line may reference MOCK_MODE.

## C3. Smart View DSL — normative grammar

```
query      := orExpr
orExpr     := andExpr ( "or" andExpr )*
andExpr    := unary ( "and" unary )*
unary      := "not" unary | "(" orExpr ")" | predicate
predicate  := fieldPred | activityPred | membershipPred | textPred
fieldPred  := field cmp value
field      := builtin | "custom." ident
builtin    := "name"|"status"|"owner"|"created"|"updated"|"last_contacted"|"last_inbound"
             |"next_task_due"|"dnc"|"opportunity.value"|"opportunity.stage"
             |"opportunity.close_date"|"contact.email"|"contact.phone"|"contact.title"
cmp        := "="|"!="|"<"|"<="|">"|">="|"contains"|"starts_with"|"is_set"|"is_not_set"
value      := string | number | bool | date | reldate     -- lists appear only in membershipPred
reldate    := number unit "ago" | "today" | "this_week" | "this_month" ;  unit := "h"|"d"|"w"|"mo"
membershipPred := field "in" "(" valueList ")"            -- "me" resolves to current user
activityPred   := ("has"|"no") activityType ("within" number unit)?
activityType   := "call"|"email"|"inbound_email"|"sms"|"note"|"task_completed"
                | "sequence" | "in_sequence" "(" string ")"
textPred   := "matches" string                            -- global FTS clause
```

Semantics (normative): case-insensitive keywords · strings double-quoted with `\"` escape · dates ISO-8601 · `custom.<key>` typed by `custom_field_defs.type` (lead-entity fields only), comparator/value type-checked at parse time (type error = parse error, position-carrying); parse-time custom-field typing implies the signature `parse(dsl, {fieldCatalog?})` · relative dates resolve at *execution* time in org timezone · `owner in (me)` binds at execution to the querying user · sequence membership surface syntax is `has in_sequence("name")` / `no in_sequence("name")` (and bare `has sequence` = enrolled in any), per the grammar as written · `opportunity.value` literals are **whole currency units** (dollars); the compiler converts to `value_cents` (×100) — a rep writes `opportunity.value > 5000` meaning $5,000 · the DSL-local field-catalog type is exported as `DslCustomFieldDef` (distinct from the DB-row `CustomFieldDef` in domain.ts).

Compiler: `parse(dsl) → AST (zod-typed)` · `compile(ast, ctx) → {sql, params[]}` — **parameters only; string-splicing any user value is a contract violation** · every compile emits `LIMIT/keyset` pagination · builder UI reads/writes the same AST (`astToDsl(ast)` round-trips: `parse(astToDsl(a)) ≡ a`).

## C4. Activity event taxonomy (payloads are zod-typed per type)

`call_logged` · `call_missed` · `voicemail_received` · `email_sent` · `email_received` · `email_bounced` · `sms_sent` · `sms_received` · `sms_opt_out` · `note_added` · `task_created` · `task_completed` · `field_changed` (payload: `{field, before, after}`) · `status_changed` · `opportunity_created` · `opportunity_stage_changed` · `opportunity_closed` · `sequence_enrolled` · `sequence_step_sent` · `sequence_paused` (payload includes reason: `reply|bounce|manual|unsubscribe`) · `sequence_finished` · `unsubscribed` · `suppression_added` · `suppression_released` · `dnc_set` · `dnc_cleared` · `lead_created` · `lead_merged` · `import_created` · `activity_correction` · `recording_consent_played`.

Rules: append-only; every outbound touch and inbound reply appears **exactly once** (dedupe upstream, not by filtering the timeline); `occurred_at` is provider time where available, ingest time otherwise; ordering key `(occurred_at, id)`. The event writer updates the C1 denormalized lead columns in the same transaction.

## C5. Email sync state machine

States: `UNLINKED → AUTHORIZING → BACKFILLING → LIVE ⇄ DEGRADED`, `LIVE → RESYNC → LIVE`, `any → REAUTH_REQUIRED → AUTHORIZING`. Transitions only via `SyncStateService.transition(accountId, to, cause)` which writes `sync_events`. Backfill checkpoints after every page. Cursor advance is transactional with message writes.

**I-SYNC (invariant, property-tested):** for any interleaving/replay/reordering of {webhook pushes, backfill pages, resyncs, worker restarts}, final DB state (messages, threads, activities) is byte-identical to a single clean pass. Test: run scripted fixture stream twice/shuffled/with duplicates → `pg_dump --data-only` of affected tables is identical modulo ids-ordering (compare canonicalized).

## C6. Send-safety invariants — the never-events (§4.3, testable form)

- **I-SEND-1 (never twice):** at most one `send_intents` row per `(enrollment_id, step_id)` ever reaches `SENT`; provider `send()` is called at most once per intent id (mock provider counts calls; property test with N concurrent workers claims).
- **I-SEND-2 (never after reply/bounce):** if a `sequence_paused(reply|bounce)` event is committed at T, no intent of that enrollment transitions to `SENT` after T. Test: fixture injects reply between scheduling and due-time; also *during* the claim window.
- **I-SEND-3 (never suppressed):** suppression check runs inside the send transaction; adding a suppression at any point before claim commit prevents send. Property test races suppression-insert vs claim.
- **I-SEND-4 (window/cap):** no send outside org sending window (recipient-local, fallback company tz) or beyond per-mailbox daily cap; cap counter increments inside the claim transaction.
- **I-SEND-5 (unsubscribe):** every sequence email includes `List-Unsubscribe` (mailto + one-click https) headers; hitting either suppresses globally ≤ 1s and emits `unsubscribed` + `sequence_paused`.
- **I-DNC:** every send/dial path (sequence, bulk, one-off, API, dialer) checks contact+lead DNC at execution time.
- **I-QUIET (SMS):** no outbound SMS outside 8am–9pm recipient-local (area-code inferred, fallback company tz); STOP/UNSUBSCRIBE/QUIT/CANCEL/END inbound → suppress number globally, confirm once, emit `sms_opt_out`.
- **I-REC:** recording only when `org_settings.recording_enabled` (admin+audit-logged change) AND consent announcement event `recording_consent_played` precedes recording start on that call; per-call rep opt-out honored.
- **I-AI:** no AI output row reaches `status='final'` or sends without an explicit user action recorded (the confirming request carries `confirmedBy`).
- **I-RAIL-API:** all invariants above hold when invoked via the internal REST API — asserted by tests that attempt bypass with a valid token.

## C7. REST + WS shapes

REST under `/api/v1`. JSON, camelCase. Auth: session cookie (web) or `Authorization: Bearer <token>` (internal API, scoped). Errors: `{error: {code, message, details?}}` with codes from C8. Pagination: `?cursor=&limit=` → `{items, nextCursor?}` (keyset).

Resources (CRUD unless noted): `leads` (+ `GET /leads/:id/timeline`, `POST /leads/merge`) · `contacts` · `opportunities` · `tasks` · `notes` · `smart-views` (+ `POST /smart-views/preview` {dsl|ast} → first page + count-estimate) · `sequences` (+ `POST /sequences/:id/enroll` bulk) · `templates` · `snippets` · `emails` (`POST /emails/send`, threads read) · `calls` (`POST /calls/dial`, `PATCH /calls/:id` outcome/notes) · `sms` (`POST /sms/send`) · `imports` (`POST /imports` multipart CSV → `POST /imports/:id/dry-run` → `POST /imports/:id/commit`) · `reports/*` (read) · `admin/*` (users, custom-fields, org-settings, suppressions, audit-log — admin RBAC) · `bulk` (`POST /bulk` {smartViewId|ast, action, params} → job id) · `search?q=` (global FTS).
Webhook ingress: `/wh/twilio/voice`, `/wh/twilio/sms`, `/wh/twilio/status`, `/wh/gmail` — signature-verified, persist-then-process, always fast-200 on verified.

WS `/ws`: server→client frames `{topic, type, payload}`; topics `inbox:<userId>`, `lead:<leadId>`; types are cache-invalidation hints (`timeline.changed`, `inbox.changed`, `call.state`) — client refetches via REST. No client→server mutations over WS.

## C8. Error taxonomy

`VALIDATION_FAILED` 400 · `UNAUTHENTICATED` 401 · `FORBIDDEN` 403 (RBAC/scope) · `NOT_FOUND` 404 · `CONFLICT` 409 (dedupe, unique) · `SUPPRESSED` 422 (send to suppressed/DNC — *not* an override prompt) · `OUTSIDE_WINDOW` 422 · `CAP_EXCEEDED` 429 · `RATE_LIMITED` 429 · `PROVIDER_ERROR` 502 (wraps adapter failures, safe-retryable flag) · `SYNC_REAUTH_REQUIRED` 409 · `INTERNAL` 500. Engine-layer rails throw typed errors; HTTP mapping is mechanical.

## C9. Quality bars (apply to every task)

TypeScript strict; no `any`/`@ts-ignore`/TODO. Tests colocated (`vitest`), DB tests on PGlite (see DECISIONS D-003), latency suite authoritative only on real Postgres. Every module works under `MOCK_MODE=1` with zero external accounts. Conventional commits. Files outside a task's allowlist are read-only.
