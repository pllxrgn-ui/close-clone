# HUMAN_TODO — things only a human can do

The build does **not** wait on any of these (mock mode covers all of them). Each item blocks the *real-mode feature* named, not the build. Check items off as you complete them; put secrets in `.env` (gitignored), never in this file.

## Accounts & keys

- [ ] **Anthropic API key** → `.env: ANTHROPIC_API_KEY=`. Needed for real Haiku 4.5 summaries/drafting/NL-search (Phase 3–4 real mode). Get one at console.anthropic.com → API Keys.
- [ ] **Google Cloud project** with Gmail API enabled + OAuth consent screen (type: *Internal*) + OAuth client (Web). → `.env: GOOGLE_CLIENT_ID=`, `GOOGLE_CLIENT_SECRET=`, redirect URI `https://<app-url>/api/auth/google/callback` (dev: `http://localhost:3000/api/auth/google/callback`). Needed for real two-way email sync (Phase 2 real mode).
  Steps: console.cloud.google.com → New project → APIs & Services → Enable "Gmail API" → OAuth consent screen (Internal) → Credentials → Create OAuth client ID (Web application) → add the redirect URI.
- [ ] **Company IdP OIDC app** (Google Workspace default): create an OIDC client, note issuer/client-id/secret → `.env: OIDC_ISSUER=`, `OIDC_CLIENT_ID=`, `OIDC_CLIENT_SECRET=`. Create groups `sales-crm-users` and `sales-crm-admins`. Needed for SSO (Phase 5). Dev login stub covers until then.
- [ ] **Twilio account** + buy ≥1 phone number → `.env: TWILIO_ACCOUNT_SID=`, `TWILIO_AUTH_TOKEN=`, `TWILIO_API_KEY_SID=`, `TWILIO_API_KEY_SECRET=`, `TWILIO_PHONE_NUMBER=`. Needed for real calling + SMS (Phase 3 real mode).
- [ ] **Deepgram API key** (optional, can defer) → `.env: DEEPGRAM_API_KEY=`. Needed for real call transcription.
- [ ] **Publicly reachable webhook URL** for dev: install a tunnel (`cloudflared tunnel` or ngrok), point it at localhost:3000, put the URL in `.env: PUBLIC_WEBHOOK_URL=`. Needed for Twilio + Gmail push callbacks in real mode.

## Infrastructure

- [ ] **Install Docker Desktop** on this machine (docker.com) — required for `docker compose up` (Postgres + Redis + app) and for running the latency gate against real Postgres locally. *Currently absent on this Windows host.*
- [ ] **GitHub repo + Actions**: create a private repo, `git remote add origin <url>`, push. CI workflow is committed and will run on push. (`gh` CLI not installed; install it or create the repo via the web UI.)
- [ ] **Deploy target**: pick internal Docker host/VM or Fly.io private app + Postgres (Phase 5). Provide `.env` values per `deploy/README` once Phase 5 lands.
- [ ] **Internal DNS name + TLS cert** for the app URL (placeholder `switchboard.internal.yourco.com`).

## Policy

- [ ] **Legal/HR sign-off on call-recording policy.** Recording ships built but OFF; an admin may enable it only after sign-off is recorded. When enabled, a consent announcement plays on every recorded call — non-skippable.

## Verification checkpoints (scripts will be appended here as phases complete)

- [ ] A real phone + a test Gmail mailbox available for Phase 2–3 real-mode checks (§8 of the build guide).
