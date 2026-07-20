# Development notes

## 2026-07-20 - Production cutover preparation

### Completed

- Added a production-only web entry and authentication provider with no mock worker or browser-stored session.
- Added the authenticated Overview page and made it the default post-login destination.
- Added complete report pagination and explicit UTC range handling.
- Added reduced-motion-aware Lenis scrolling to the public welcome page.
- Connected the real Gmail, Twilio, Deepgram, and Anthropic provider registries and made production startup fail when required integration configuration is absent.
- Added offline verification for authenticated Gmail Pub/Sub push JWTs, including signature, issuer, audience, expiry, verified service-account email, and envelope checks.
- Added the Vercel-to-Render proxy layout and a Render Blueprint for the API, PostgreSQL, and Key Value service.
- Removed the GitHub Pages demo deployment workflow and demo-only lead reply control.

### Files Changed

- `apps/web/src/auth`, `apps/web/src/features/overview`, `apps/web/src/features/reports`, and `apps/web/src/features/welcome`
- `apps/api/src/main.ts` and `apps/api/src/providers/registry.ts`
- `vercel.json`, `render.yaml`, deployment documentation, and environment templates

### Decisions Made

- Production uses Vercel for the web client and Render for the API, managed PostgreSQL, and managed Key Value service.
- Vercel reverse proxies API and webhook routes so secure authentication cookies remain same-origin.
- Production builds exclude mock boot code and fail closed when any required provider configuration is missing.

### How to Test

- Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, and `pnpm test:deploy` on Node 24.
- Inspect `apps/web/dist` to confirm the mock worker and demo identifiers are absent.
- After infrastructure provisioning, exercise SSO, provider webhooks, Overview, and all three reports against production data.

### Next Steps

- Add Render billing information and provision the Blueprint.
- Supply the OIDC, Gmail, Twilio, Deepgram, and Anthropic production secrets.
- Set the final Render API origin in Vercel, deploy, and complete the rendered production smoke test.
