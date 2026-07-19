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

## Vercel demo (stable public URL, no laptop required)

The mock demo is deployed to Vercel (account `pllxrgn-ui` (GitHub-linked)) under two
projects serving the same build:

- **https://switchboard-demo-omega.vercel.app** — the primary, clean address
- https://switchboard-demo-omega.vercel.app — the original link, kept alive
  so anything already shared keeps working

Static hosting of `apps/web/dist` (mock mode, MSW in-browser) with one SPA
rewrite so deep links (`/inbox`, `/leads/:id`) serve `index.html`. To redeploy
after changes:

```bash
rm -rf apps/web/dist                      # dist accumulates otherwise
pnpm --filter @switchboard/web build      # must print "built in ..." (a tsc error = stale dist!)
STAGE=$(mktemp -d)/switchboard-demo && mkdir -p "$STAGE"
cp -r apps/web/dist/. "$STAGE/"
printf '{ "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }' > "$STAGE/vercel.json"
(cd "$STAGE" \n  && DEPLOY=$(npx vercel deploy --prod --yes 2>&1 | grep -oE 'https://[a-z0-9.-]+vercel\.app' | tail -1) \n  && npx vercel alias set "$DEPLOY" switchboard-demo-omega.vercel.app)
# Fresh project under pllxrgn-ui: `--prod` auto-updates the production
# alias; the explicit alias set is a harmless belt-and-braces. The edge may
# serve the previous HTML for a couple of minutes after a deploy.
# Repeat from a dir named switchboard-crm-demo to update the primary URL.
```

Two stale projects remain on the FORMER account (`pdvillorente12-1736`):
`switchboard-demo` + `switchboard-crm-demo` — delete via that account's
dashboard when convenient (Settings → Delete Project).

GitHub Pages remains the auto-deploying mirror (every push to main):
https://pllxrgn-ui.github.io/close-clone/
