# HUMAN_TODO — things only a human can do

The build does **not** wait on any of these (mock mode covers all of them). Each item blocks the *real-mode feature* named, not the build. Check items off as you complete them; put secrets in `.env` (gitignored), never in this file.

## Accounts & keys

- [ ] **Anthropic API key** → `.env: ANTHROPIC_API_KEY=`. Needed for real Haiku 4.5 summaries/drafting/NL-search (Phase 3–4 real mode). Get one at console.anthropic.com → API Keys.
- [ ] **Google Cloud project** with Gmail API enabled + OAuth consent screen (type: *Internal*) + OAuth client (Web). Configure `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and the redirect URI `https://<app-url>/api/v1/oauth/gmail/callback` (dev: `http://localhost:3000/api/v1/oauth/gmail/callback`). Create an authenticated Pub/Sub push subscription for `/wh/gmail`, then set `GMAIL_PUSH_AUDIENCE` and `GMAIL_PUSH_SERVICE_ACCOUNT_EMAIL` to its exact audience and push-auth service account. Needed for real two-way email sync (Phase 2 real mode).
  Steps: console.cloud.google.com → New project → APIs & Services → Enable "Gmail API" → OAuth consent screen (Internal) → Credentials → Create OAuth client ID (Web application) → add the redirect URI.
- [ ] **Company IdP OIDC app** (Google Workspace default): create an OIDC client, note issuer/client-id/secret → `.env: OIDC_ISSUER=`, `OIDC_CLIENT_ID=`, `OIDC_CLIENT_SECRET=`. Create groups `sales-crm-users` and `sales-crm-admins`. Needed for SSO (Phase 5). Dev login stub covers until then.
- [ ] **Twilio account** + buy ≥1 phone number → `.env: TWILIO_ACCOUNT_SID=`, `TWILIO_AUTH_TOKEN=`, `TWILIO_API_KEY_SID=`, `TWILIO_API_KEY_SECRET=`, `TWILIO_PHONE_NUMBER=`. Needed for real calling + SMS (Phase 3 real mode).
- [ ] **Deepgram API key** (optional, can defer) → `.env: DEEPGRAM_API_KEY=`. Needed for real call transcription.
- [ ] **Publicly reachable webhook URL** for dev: install a tunnel (`cloudflared tunnel` or ngrok), point it at localhost:3000, put the URL in `.env: PUBLIC_WEBHOOK_URL=`. Needed for Twilio + Gmail push callbacks in real mode.

## Infrastructure

- [x] ~~**Install Docker Desktop**~~ — DONE (Docker 29.2.1 + Compose v5). The full stack boots for real: `cd deploy && cp .env.example .env` (set `POSTGRES_PASSWORD` + a 32+ char `SESSION_SECRET`) then `docker compose --env-file .env -f docker-compose.yml up -d`. **Verified end-to-end 2026-07-18: ALL FOUR services healthy** (postgres 16.14 + redis 7 + api + web), 31 tables migrated, the composition root serves the full route/worker graph authenticated (unauth → 401 through the nginx proxy, `/healthz` green, CSP + X-Frame-Options DENY on the front door), real SSO proven against the bundled Keycloak profile, and the **backup + restore drill PASSES**. Supersedes D-001. Remaining infra items below are the production host, not the app.
- [ ] **GitHub repo + Actions**: create a private repo, `git remote add origin <url>`, push. CI workflow is committed and will run on push. (`gh` CLI not installed; install it or create the repo via the web UI.)
- [ ] **Deploy target**: pick internal Docker host/VM or Fly.io private app + Postgres (Phase 5). Provide `.env` values per `deploy/README` once Phase 5 lands.
- [ ] **Internal DNS name + TLS cert** for the app URL (placeholder `switchboard.internal.yourco.com`).

## Policy

- [ ] **Legal/HR sign-off on call-recording policy.** Recording ships built but OFF; an admin may enable it only after sign-off is recorded. When enabled, a consent announcement plays on every recorded call — non-skippable.

## Showcase — the ONE thing to do now

- [x] ~~GitHub repo~~ — done: `github.com/ITGuns/close-clone`, `main` pushed, CI + Pages workflows armed.
- [ ] **Enable GitHub Pages → makes the demo URL live.** Repo → Settings → Pages → *Build and deployment* → Source: **GitHub Actions**. One click; the `pages.yml` workflow then publishes the mock-mode demo at **https://itguns.github.io/close-clone/welcome** (synthetic fixture data — safe to share; append `/welcome` for the landing). Redeploys on every push to `main`.
- (Alternative, not needed: Vercel import per `DEPLOY-PREVIEW.md` Option B — `vercel.json` is committed if you ever prefer it.)

## Verification checkpoints (scripts will be appended here as phases complete)

- [ ] A real phone + a test Gmail mailbox available for Phase 2–3 real-mode checks (§8 of the build guide).
