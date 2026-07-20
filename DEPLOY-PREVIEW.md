# Production deployment — Vercel web + Render backend

The production topology is split by responsibility:

- Vercel serves `apps/web/dist` and proxies `/api/v1/*`, `/wh/*`, and `/healthz` to Render.
- Render runs the Fastify API and its in-process BullMQ consumers from `apps/api/Dockerfile`.
- Render Postgres is the source of truth; Render Key Value carries BullMQ work only.
- `render.yaml` defines the backend, persistent import disk, health check, and generated secrets.

## Required external configuration

Before the first Render Blueprint deploy, add billing information and provide every `sync: false`
secret requested by `render.yaml`: company OIDC, Gmail, Twilio, Deepgram, Anthropic, and optional
Sentry. Register these callbacks with the providers:

- OIDC: `https://switchboard-demo-omega.vercel.app/api/v1/auth/callback`
- Gmail OAuth: `https://switchboard-demo-omega.vercel.app/api/v1/oauth/gmail/callback`
- Gmail push: `https://switchboard-api-pllxrgn.onrender.com/wh/gmail`
- Twilio voice/SMS/status: the matching `/wh/twilio/*` routes on the Render origin

`MOCK_MODE=0` fails closed until OIDC and `WEB_ORIGIN` are configured. Provider-specific routes
mount only when their credential group exists.

## Release order

1. Validate: `render blueprints validate render.yaml --output json`.
2. Create the Render Blueprint from `render.yaml` and wait for `/healthz` to report ready.
3. Complete an OIDC sign-in and provider callback smoke test against the Vercel origin.
4. Deploy Vercel from the repository root. `.env.production` forces the real API build.
5. Verify `/welcome`, `/login`, `/overview`, `/reports`, and one authenticated write flow.

Do not deploy the Vercel cutover before the Render API is healthy: the production build contains
no browser mock fallback.

## Rollback

Rollback Vercel to its previous deployment and Render to its previous image. Migrations remain
additive; restore Postgres only for confirmed data corruption, using Render's managed recovery.
