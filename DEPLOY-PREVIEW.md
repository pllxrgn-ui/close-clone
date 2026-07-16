# Deploying the showcase preview (Vercel, mock-data mode)

The Vercel deployment is the **web app in demo mode**: the full UI (landing → login → app) backed by MSW with the synthetic fixture dataset. No backend, no secrets, no real data — safe on a shareable preview URL. The real-engine demo (PGlite API + 5k leads) runs locally per `DEMO.md`.

## One-time setup (~2 minutes)

1. vercel.com → **Add New… → Project** → Import `ITGuns/close-clone`.
2. Framework preset: **Other** (vercel.json supplies everything: pnpm install, `pnpm --filter @switchboard/web build`, output `apps/web/dist`, SPA rewrites).
3. No environment variables needed — the build defaults to mock mode (`VITE_API_MODE` unset ⇒ MSW on).
4. Deploy. The URL opens on the app; append `/welcome` for the landing page (or share `<url>/welcome` directly — that's the front door).

Optional: Project → Settings → Deployment Protection → password-protect the URL if you want it gated.

## Redeploys

Every push to `main` redeploys automatically once the project is connected.

## Do not

- Do not set `VITE_API_MODE=real` on Vercel — there is no API there; the app would show connection errors.
- Do not add secrets to the Vercel project; the demo build needs none.
