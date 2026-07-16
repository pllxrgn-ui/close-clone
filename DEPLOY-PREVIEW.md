# Deploying the showcase preview (mock-data demo app)

The shared deployment is the **web app in demo mode**: the full UI (landing → login → app) backed by MSW with the synthetic fixture dataset. No backend, no secrets, no real data. The real-engine demo (PGlite API + 5k leads) runs locally per `DEMO.md`.

## Option A — GitHub Pages (repo is public; zero extra accounts) ✓ preferred

Workflow `.github/workflows/pages.yml` builds and deploys on every push to `main`.

**One-time click (yours):** repo → Settings → Pages → _Build and deployment_ → Source: **GitHub Actions**. That's it.

Demo URL after the first deploy: **https://itguns.github.io/close-clone/** (share `…/close-clone/welcome` as the front door). Deep links work (SPA 404 fallback); the app is built with `VITE_BASE=/close-clone/`.

## Option B — Vercel (~2 minutes)

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
