# Development notes

## 2026-07-20 - Self-service Gmail inbox connection

### Completed

- Added a rep-accessible Inboxes settings section with connect, status, disconnect, and reconnect actions.
- Added owner-scoped email-account list/disconnect routes and session-derived OAuth linking.
- Signed and expired OAuth state, verified callback ownership, and rejected mismatched Google mailbox addresses before token storage.
- Added authenticated mailbox discovery to the email provider contract and kept OAuth tokens encrypted at rest.
- Added a credential-free MSW implementation of the complete inbox flow and hid admin-only settings/commands from reps.
- Added the first-party CSRF header to all mutating web API requests.

### Files Changed

- `apps/api/src/routes/email-sync.ts`, email providers, sync linking/errors, and focused tests
- `apps/web/src/features/admin/settings`, admin API/mock handlers/store, and focused tests
- `apps/web/src/api/client.ts` and its security test
- `packages/shared/src/providers.ts`

### Decisions Made

- Users authorize their own mailbox; they never supply Google API keys. The deployment owns one Google OAuth client.
- Disconnect removes local authorization and cursors but preserves imported messages and the reconnectable account row.
- Demo mode completes linking in-app; real mode performs a full-page Google OAuth navigation.

### How to Test

- Sign in as a rep, open Settings, connect an email, disconnect it, and reconnect it.
- Run the focused API email-sync/provider suites and the web Settings/client suites.
- After Google credentials are provisioned, repeat the flow through the real Google consent screen and confirm the mailbox reaches `LIVE`.

### Next Steps

- Provision the Google Cloud OAuth client and authenticated Pub/Sub push subscription, then perform the live-provider smoke test.
- Ratify the corresponding `EmailProvider.getMailboxAddress` and owner-scoped REST additions in the normative contract ledger.

## 2026-07-20 - Zero-account completion and provider-ready wiring

### Completed

- Changed real-mode startup from all-provider-or-nothing to core-required plus optional atomic Gmail/Twilio groups.
- Decoupled Anthropic drafting and NL Smart Views from optional Deepgram call transcription.
- Mounted SMS, dialer, voicemail, AI, and import routes in the production and zero-account real-API composition roots.
- Bound the in-process sequence and telephony workers in the zero-account real-API server.
- Added delivery-time webhook DNS resolution, public-address validation, and IP pinning to prevent DNS rebinding.
- Expanded the outbound webhook address denylist and normalized missing-provider failures.
- Repaired the Playwright harness so it always builds mock mode, cannot silently attach to another app, supports `E2E_PORT`, and follows the current `/overview` login destination.

### Files Changed

- `apps/api/src/main.ts`, `apps/api/src/dev/boot.ts`, provider-backed routes/services, and focused tests
- `apps/api/src/services/webhooks/secure-sender.ts` and webhook URL policy
- `.github/workflows/e2e.yml`, `e2e/playwright.config.ts`, and the login journeys
- `README.md`, `STATUS.md`, `HUMAN_TODO.md`, `DEPLOY-PREVIEW.md`, and `deploy/WIRING.md`

### Decisions Made

- OIDC and public origins remain mandatory for real mode; vendor integrations are optional but partial multi-key groups fail closed.
- Provider routes activate by capability: Anthropic does not wait for Deepgram, while call summaries report a clear provider error until transcription is configured.
- The zero-account real-API path uses the same route and async-worker contracts as production, with mock adapters below the seam.

### How to Test

- Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, and `pnpm test:deploy` on Node 24.
- Run `pnpm --filter @switchboard/api run dev:mock`, then the web with `VITE_API_MODE=real`, and exercise calling, SMS, AI, imports, and sequence enrollment.

### Verification Evidence

- Passed: focused changed API suites, 80/80; Playwright production-build E2E, 13/13; typecheck, lint, format check, build, and deploy-kit tests.
- Full API run: 1,725 passed, 16 skipped, and 20 files failed on fixed 5–10 second hook/performance timeouts under concurrent PGlite saturation; all changed suites passed in that run and in isolation.
- Full web run: 1,358 passed with 5 timeout failures under load; the exact five files then passed 33/33 in isolation.
- Environment caveat: this host is Node 22.14.0 while the repository requires Node 24 or newer.
- Manual rendered clickthrough: blocked because the isolated in-app browser runtime was unavailable; Playwright supplied the zero-account rendered-browser gate instead.

### Next Steps

- Provision external accounts and perform live-provider smoke tests.
- Provision Render and complete the authenticated Vercel-to-Render cutover.

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
- Production builds exclude mock boot code, require the secure OIDC/public-origin core, and fail closed on partially configured provider groups.

### How to Test

- Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, and `pnpm test:deploy` on Node 24.
- Inspect `apps/web/dist` to confirm the mock worker and demo identifiers are absent.
- After infrastructure provisioning, exercise SSO, provider webhooks, Overview, and all three reports against production data.

### Next Steps

- Add Render billing information and provision the Blueprint.
- Supply the OIDC, Gmail, Twilio, Deepgram, and Anthropic production secrets.
- Set the final Render API origin in Vercel, deploy, and complete the rendered production smoke test.

## 2026-07-21 - Welcome and Support motion refresh

### Completed

- Recorded the Welcome workflow, native Support disclosures, scoped GSAP reveal refresh, and final verification results.

### Files Changed

- `apps/web/src/pages/HelpPage.tsx`, `apps/web/src/pages/helpContent.tsx`, and `apps/web/src/app/shell.css`
- `apps/web/src/features/welcome/WorkflowStory.tsx`, Welcome copy/page/styles, and reveal tests
- `apps/web/package.json` and `pnpm-lock.yaml` for GSAP and `@gsap/react`

### Decisions Made

- Kept the rendered-browser gate blocked when the in-app Browser reported that `iab` was unavailable; no source-inspection substitute was used.
- Kept this session note unstaged because `docs/dev-notes.md` already had unrelated user changes.

### How to Test

- Run the focused Help, rail, Welcome, and reveal test command from `docs/superpowers/plans/2026-07-21-welcome-support-motion.md`.
- Run web typecheck, lint, build, Prettier check, and `git diff --check` on Node 24 or newer.
- When the in-app Browser is available, complete the desktop/mobile and light/dark `/welcome` and authenticated `/help` click-through described in the plan.

### Verification Evidence

- Focused tests: 4 files and 31 tests passed twice with exit 0 and no unhandled GSAP error after the ScrollTrigger test lifecycle fix.
- Passed: web typecheck, lint, production build (2,163 modules), scoped Prettier check, and `git diff --check`.
- The focused suite still prints the existing React `act(...)` warning from `rail.test.tsx`; it does not fail the command and is unrelated to GSAP teardown.
- Environment caveat: this host is Node 22.14.0 while the repository requires Node 24 or newer; these results are not Node 24 verification.
- Manual rendered click-through: blocked because the in-app Browser returned `Browser is not available: iab`.

### Next Steps

- Rerun the focused and static checks on Node 24 or newer.
- Complete the blocked rendered click-through when the in-app Browser is available.

## 2026-07-22 - Full feature audit and real-API account-flow repair

### Completed

- Attached valid dev-login identities to real-API feature requests so inbox accounts and other account-scoped routes work after login.
- Wired authenticated actors into Smart View creation, bulk actions, imports, email sending, and audit attribution instead of using the fallback fixture owner.
- Made the no-provider Gmail demo complete its mock OAuth callback locally and reach the `LIVE` sync state for each signed-in demo user.
- Added regression coverage for authenticated inbox access, local inbox connection, and per-user Smart View ownership.
- Raised the randomized recording-consent property test's local timeout without weakening its invariant.
- Pinned both transitive `fast-uri` major lines to patched releases; the production dependency audit now reports no known vulnerabilities.

### Files Changed

- `apps/api/src/dev/boot.ts` and `apps/api/src/dev/smoke.test.ts`
- `apps/api/src/providers/mock/mock-email-provider.ts` and `apps/api/src/providers/registry.ts`
- `apps/api/src/services/telephony/recording.property.test.ts`
- `package.json` and `pnpm-lock.yaml`

### Decisions Made

- Keep unauthenticated demo reads available, but decorate valid signed sessions with the same user and audit context production routes consume.
- Keep production OAuth unchanged; only the dev mock provider receives a local callback URL and demo authorization code.
- Preserve per-user ownership in the real-API demo for every mutation path that exposes an actor seam.

### How to Test

- Use Node 24.18 or newer and run `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm audit --prod`, and `pnpm test:deploy`.
- Run API tests serially with `pnpm --filter @switchboard/api exec vitest run --maxWorkers=1 --fileParallelism=false` on PGlite-constrained hosts.
- Run the web suite serially with `pnpm --filter @switchboard/web exec vitest run --maxWorkers=1 --fileParallelism=false`.

### Verification Evidence

- Backend: 157 files and 1,770 tests passed in a full serial run.
- Frontend: 124 files and 1,378 tests passed in a full serial run.
- Final affected regression: the complete 29-test real-API smoke suite plus all 38 Gmail route/provider tests passed.
- Production build, workspace typecheck, workspace lint, scoped Prettier check, deploy-kit tests, and `git diff --check` passed.
- `pnpm audit --prod` reports no known vulnerabilities after the patched `fast-uri` overrides.
- Existing production-build Playwright suite passed 13/13 before the backend-only repair; the repaired account flow additionally passes in the real-API dev smoke suite.
- Manual in-app Browser click-through remains blocked because the required bundled browser client is unavailable in this environment; automated rendered E2E and in-process real-API coverage are recorded separately.

### Next Steps

- Complete the manual desktop/mobile click-through when the in-app Browser runtime is restored.
- Provision live OIDC/Gmail/Twilio/Deepgram/Anthropic accounts and run provider smoke tests before production launch.
