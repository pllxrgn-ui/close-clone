# Production composition wiring (Wave A readiness)

> **STATUS — this checklist is now BUILT and PROVEN (D-042/D-043/D-044, 2026-07-18).**
> The production composition root exists at **`apps/api/src/main.ts`** and the
> container entry (`index.ts`) runs it. Wired + verified against real
> Postgres 16 + Redis 7: advisory-locked migrate-on-boot · global session-OR-
> bearer gate over `/api/v1/*` (F4) with route-derived token scopes (I-RAIL-API:
> read token reads not mutates) · `requireAdmin` on admin surfaces + imports ·
> real `/healthz` (pg + queue depth) · pino with redaction · error sink · graceful
> shutdown · the sequence/telephony/webhook workers + sweepers · real OIDC
> login/callback (proven end-to-end against the bundled Keycloak, see
> `deploy/KEYCLOAK.md`) · telephony + AI + token/webhook-CRUD routes. Everything
> account-gated (Gmail/Twilio/Deepgram/Haiku, real IdP) degrades gracefully —
> unmounted until its account lands, never blocking boot.
>
> **Genuinely remaining** (account-gated or service-layer, NOT `main.ts`): real
> provider construction in `createProviderRegistry`'s real branch for
> telephony/asr/ai + Gmail; webhook EMISSION (firing `emitWebhookEvent` on
> domain events — a service-layer hook); delivery-time resolve-and-pin vs DNS
> rebinding. The sections below are the original checklist, kept for reference.

The Wave A subsystems (SSO, API tokens, outbound webhooks, observability) are merged, tested (399 tests), and exported as factories. This file is the checklist to wire them into the **production** composition root when the deploy environment exists (Redis, a real OIDC issuer, real Postgres). They are intentionally NOT force-wired into the minimal `apps/api/src/server.ts` (a test/embedded helper) or the PGlite dev server, because each needs infra to run and end-to-end verify. Security headers ARE already wired (infra-free).

Do this in the deploy/production server entry (the one that owns real config, Redis, and TLS-terminated ingress), not in `server.ts` or `dev/boot.ts`.

## 1. Observability (`apps/api/src/observability/`)

- `registerSecurityHeaders(app)` — already wired in `server.ts` (infra-free); keep.
- Replace the `/healthz` stub with `registerHealthz(app, { db, queueProbe, syncLag })` — pass a real BullMQ queue-depth probe and the sync-lag options. `server.test.ts` pins the stub shape `{ok, checks:{}}`; update that test when the real healthz lands.
- `registerHttpObservability(app, { … })` — pino structured logging with request-id propagation + secret redaction (redaction is proven by tests).
- Error handler: mount the `ErrorSink` (DSN-gated Sentry/GlitchTip sink; console/no-op default) WITHOUT changing the C8 response mapping.
- `AlertMonitor` / `emitAlerts` — wire queue-depth + sync-lag thresholds to structured `alert` log lines.
- `createGracefulShutdown(...)` + `runShutdown` on SIGINT/SIGTERM — drain, close pg + queue.

## 2. SSO + RBAC (`apps/api/src/auth/`) — real mode only

- Mount `registerOidcAuthRoutes(app, …)` (GET login/callback, POST logout, GET me) as the real-mode issuer, REPLACING the dev-login stub (`dev/auth.ts`) when `MOCK_MODE` is off. Keep dev-login under MOCK_MODE — no branch above the adapter line.
- App-level `requireSession` preHandler on `/api/v1/*` with EXEMPTIONS: `/wh/*`, the public one-click unsubscribe, `/healthz`, and dev-login under MOCK_MODE.
- `requireAdmin` is the real `adminGuard` that `admin-audit` / `admin-export` / admin routes expect — thread it into `RouteDeps.adminAudit.adminGuard`, `adminExport.adminGuard`, etc. (currently those routes accept an injected guard).
- Config: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `SESSION_SECRET`; IdP groups `sales-crm-users` / `sales-crm-admins` (HUMAN_TODO).
- Optional hard kill-switch (instant global token revocation before idle-exp): needs a session/denylist table (migration 0012) — only if org policy requires it (D-028).

### Review findings 3 & 4 (2026-07-16 5h review) — this composition root is where they close

Both findings are latent only until auth is mounted here; wiring this section is what makes them safe, so treat these as its acceptance criteria:

- **(F3) `actorId` for `POST /emails/send` MUST derive from the authenticated principal, never the request body.** The body `actorId` is a documented pre-auth seam (`services/templates/access.ts`). Once the session/bearer auth above is mounted, the send route MUST overwrite the incoming `actorId` with the authenticated identity (`request.user` for session, the api-token's principal for Bearer) — or assert-equal and reject with `FORBIDDEN` on mismatch. A caller must not be able to act as another user by setting `actorId` in the payload. This applies to the internal API surface too (never bypass via a scoped token).
- **(F4) The global `requireSession` preHandler MUST be applied to `/api/v1/*`** (with the exemptions already listed in this section: `/wh/*`, the public one-click unsubscribe, `/healthz`, and dev-login under MOCK_MODE), **and the RBAC guard MUST be supplied to `registerImportRoutes`.** Import is a bulk-write resource (multipart CSV → dry-run → commit) and must not be reachable without an authenticated, authorized principal — do not leave the import routes on their injected-guard default in production.

## 3. API tokens + outbound webhooks (`apps/api/src/services/{tokens,webhooks}/`)

- `registerRoutes` already threads optional deps. Wire: `deps.adminAudit`/`adminExport` guards (from §2), and mount `registerAdminTokenRoutes` + `registerWebhookSubscriptionRoutes` (admin-guarded) via the same opt-in pattern.
- Bearer preHandler (`services/tokens/pre-handler.ts`) on the internal API surface: hash lookup, scope check, rate-limit (Postgres fixed-window — no Redis needed; self-provisions its table).
- Outbound webhook fan-out worker: bind the BullMQ `QueueDriver` (real Redis) to `services/webhooks/fanout.ts`; the in-process driver covers tests/MOCK_MODE. HMAC signing + retries/backoff/dead-letter are tested.
- Simplify the 5a/5c audit-action workarounds now that the catalog (D-028) has `auth.logout` + `api_token.*` + `webhook_subscription.*`.

## 4. Deploy (`deploy/`)

- `docker compose up` per `deploy/README.md`; run `deploy/VERIFY.md` on the Docker host (compose config validate → up → healthz green → restore-drill PASS). Docker is absent on the current build host (D-001) — this is HUMAN_TODO.

## Verification gate

None of the above is "done" until it runs green against real Postgres + Redis + a real (or staged) OIDC issuer. Until then it is merged, unit/integration-tested on PGlite + in-process drivers, and wired per this file. That is the honest status.

## 5. Telephony / SMS / AI (Phase 3 — `apps/api/src/{providers/telephony,providers/ai,providers/asr,services/telephony,services/sms,services/ai}`)

`registerRoutes` now threads optional `telephony` / `sms` / `ai` deps (mounted only when supplied). Under MOCK_MODE the registry binds `telephony`/`asr`/`ai` mocks; wire the real adapters + route deps at the deploy root:

- **Providers (real branch of `createProviderRegistry`):** `telephony: createTwilioTelephonyProvider({ accountSid, authToken, apiKeySid, apiKeySecret, twimlAppSid, voiceUrl, statusCallbackUrl, transport: new FetchTwilioTransport() })`, `asr: createDeepgramASRProvider({ apiKey, transport })`, `ai: createHaikuAIProvider({ apiKey, transport })`. All keyed by accounts in HUMAN_TODO (Twilio/Deepgram/Anthropic).
- **Telephony routes:** `registerRoutes(app, { …, telephony: { verifier: new SignatureTwilioVerifier(authToken), dialProvider: registry.telephony, now, publicBaseUrl: <external origin, NOT the proxy host>, callerId: TWILIO_PHONE_NUMBER, queue?, dialerClient: <raw pg client> } })`. Twilio signs the full public URL — `publicBaseUrl` must be the real external origin. Under MOCK_MODE use `SignatureTwilioVerifier(MOCK_TWILIO_AUTH_TOKEN)` + the mock provider.
- **SMS route:** `sms: { provider: registry.telephony, now, fromNumber: TWILIO_PHONE_NUMBER }`. Outbound quiet-hours (I-QUIET) + DNC are enforced in the send engine; inbound STOP is handled by the telephony ingress processor.
- **AI routes:** `ai: { asr: registry.asr, ai: registry.ai, now, fieldCatalog? }`. I-AI holds: summaries land as DRAFT notes; a separate confirm endpoint (carrying `confirmedBy`) flips to final + emits the timeline event. NL→Smart View re-parses the model's DSL through the shared parser (invalid = visible error).
- **Webhook worker:** the telephony ingress persists then enqueues `twilio:process`; the composition root's combined QueueDriver processor must call `handleTelephonyJob(...)` alongside the sequence handler, and run `processPendingTwilioWebhooks(...)` on a sweeper interval (mirrors the sequence sweeper).
- **Ring group (contract gap):** no first-class ring-group table in C1; v1 routes inbound to active-users-minus-owner (`ActiveUsersRingGroup`, injectable). A real ring group needs a schema addition (migration 0012+) if desired.
- **Recording (I-REC):** default OFF (`org_settings.recording_enabled`); enabling is an admin+audited switch; `recording_consent_played` is emitted before recording on every recorded call. Legal sign-off is HUMAN_TODO.
