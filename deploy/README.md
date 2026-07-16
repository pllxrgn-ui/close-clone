# Switchboard deploy kit

One command brings up the whole stack on an internal Docker host / small VM
(ARCHITECTURE section 8). Everything here is self-contained: `docker compose`,
two Dockerfiles, backup/restore scripts, and the docs. TLS is terminated upstream
by the company proxy; the app speaks plain HTTP behind it.

```
            company TLS proxy / internal LB   (terminates HTTPS)
                          │  http
                    ┌─────▼─────┐  :8080
                    │    web    │  nginx: static SPA + gzip + security headers
                    │  (nginx)  │  reverse-proxy /api /ws /wh /healthz
                    └─────┬─────┘
                          │  http (compose network — no host ports)
                    ┌─────▼─────┐
                    │    api    │  Fastify. role=server: migrate-on-boot → serve
                    │ (node TS) │  role=worker: sweep/send (profile-gated, see below)
                    └──┬─────┬──┘
              ┌────────▼─┐ ┌─▼────────┐
              │ postgres │ │  redis   │   internal only, named volumes,
              │  (truth) │ │ (BullMQ) │   postgres → WAL archive volume
              └──────────┘ └──────────┘
```

## Prerequisites

- Docker Engine + the Compose v2 plugin (`docker compose version`).
- A copy of this repo on the host.
- `.env` created from `.env.example` (see the matrix below). Only two values are
  required for a first mock-mode bring-up: `POSTGRES_PASSWORD` and `SESSION_SECRET`.

## Quickstart (one command)

```bash
cp .env.example .env
# edit .env: set POSTGRES_PASSWORD and SESSION_SECRET (MOCK_MODE=1 is fine)
docker compose --env-file .env -f deploy/docker-compose.yml up -d --build
```

Then verify per **`deploy/VERIFY.md`** (compose config validates, all health
checks go green, `/healthz` responds, the restore drill prints PASS).

Stop / tear down:

```bash
docker compose -f deploy/docker-compose.yml down          # keep volumes (data safe)
docker compose -f deploy/docker-compose.yml down -v       # ALSO delete volumes (wipes data)
```

## `.env` matrix

| Variable                                                     | Service(s)     | Secret                            | Notes                                                                                          |
| ------------------------------------------------------------ | -------------- | --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `MOCK_MODE`                                                  | api            | no                                | `1` = all providers mocked, zero accounts. `0` = real integrations.                            |
| `NODE_ENV`                                                   | api            | no                                | `production`.                                                                                  |
| `PORT`                                                       | api            | no                                | In-container api port (3000). Not host-published.                                              |
| `WEB_HTTP_PORT`                                              | web            | no                                | Host port for the nginx front door (default 8080).                                             |
| `POSTGRES_USER`                                              | postgres, api  | no                                | Also composes `DATABASE_URL`.                                                                  |
| `POSTGRES_PASSWORD`                                          | postgres, api  | **yes**                           | **Set before first boot.**                                                                     |
| `POSTGRES_DB`                                                | postgres, api  | no                                | Database name.                                                                                 |
| `DATABASE_URL`                                               | api            | yes                               | Auto-derived to in-cluster postgres; set only to use an external DB.                           |
| `REDIS_URL`                                                  | api            | no                                | Auto-derived to in-cluster redis; set only for external Redis.                                 |
| `SESSION_SECRET`                                             | api            | **yes**                           | Signs sessions AND derives the OAuth-token encryption key. Rotating it forces mailbox re-auth. |
| `LIST_UNSUBSCRIBE_SECRET`                                    | api            | **yes**                           | Signs one-click unsubscribe tokens (I-SEND-5).                                                 |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET`      | api            | secret=client secret              | Company SSO. Groups `sales-crm-users` / `sales-crm-admins`. Dev-login stub covers until set.   |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`                  | api            | secret=secret                     | Gmail two-way sync (real mode).                                                                |
| `ANTHROPIC_API_KEY`                                          | api            | **yes**                           | Haiku 4.5 summaries/drafting/NL-search.                                                        |
| `TWILIO_*` (5)                                               | api            | secret=auth token, api-key secret | Calling + SMS (real mode).                                                                     |
| `DEEPGRAM_API_KEY`                                           | api            | **yes**                           | Call transcription (optional).                                                                 |
| `PUBLIC_WEBHOOK_URL`                                         | api            | no                                | Public HTTPS the proxy forwards to `/wh/*`.                                                    |
| `GLITCHTIP_SECRET_KEY`                                       | glitchtip      | **yes**                           | Only if the `glitchtip` profile is enabled.                                                    |
| `GLITCHTIP_DB` / `GLITCHTIP_DOMAIN` / `GLITCHTIP_FROM_EMAIL` | glitchtip      | no                                | GlitchTip config.                                                                              |
| `BACKUP_DIR` / `BACKUP_RETENTION`                            | backup scripts | no                                | Override backup location / retention (default N=14).                                           |

Real-provider variables map 1:1 to `HUMAN_TODO.md` items; each blocks only its
named feature. The stack is fully bring-up-able and verifiable with `MOCK_MODE=1`
and none of them set.

## TLS

The app never terminates TLS. The company reverse proxy / internal LB terminates
HTTPS and forwards plain HTTP to the `web` service on `WEB_HTTP_PORT`. `web`
(nginx) serves the SPA and proxies `/api`, `/ws`, `/wh`, `/healthz` to `api` on
the internal compose network. **HSTS belongs on the upstream terminator**, not in
`deploy/web/nginx.conf` (an HSTS header sent over plain HTTP is ignored). Postgres
and Redis publish **no** host ports — they are reachable only inside the compose
network.

## Services & health

| Service                          | Image                           | Health probe                  | Notes                                             |
| -------------------------------- | ------------------------------- | ----------------------------- | ------------------------------------------------- |
| `web`                            | `switchboard-web:0.1.0` (built) | `GET /nginx-health`           | Non-root nginx-unprivileged, :8080.               |
| `api`                            | `switchboard-api:0.1.0` (built) | `GET /healthz`                | server role; migrates on boot.                    |
| `worker`                         | `switchboard-api:0.1.0` (built) | heartbeat file                | **Profile `worker`, OFF by default** (see below). |
| `postgres`                       | `postgres:16`                   | `pg_isready`                  | Data volume + WAL-archive volume.                 |
| `redis`                          | `redis:7`                       | `redis-cli ping`              | Append-only persistence.                          |
| `glitchtip` / `glitchtip-worker` | `glitchtip/glitchtip:v4.0`      | HTTP `/health/` / celery ping | **Profile `glitchtip`, OFF by default.**          |

`depends_on` uses health conditions: `api` waits for postgres+redis healthy; `web`
waits for api healthy. Every service has a restart policy (`unless-stopped`) and a
memory limit sized for a small VM (honoured by `docker compose up` in Compose v2).

## Workers & multi-replica

`api` and `worker` are the **same image**; the role is chosen by `APP_ROLE`
(`server` | `worker`) in `deploy/scripts/entrypoint.sh`.

- **v1 (default):** the sequence sweeper/sender runs **in-process** in the `api`
  server. The dedicated `worker` service is **profile-gated OFF** because the
  standalone worker composition root (`apps/api/src/worker.ts`) is a tracked
  follow-up — the entrypoint fails fast with a clear message if you enable the
  profile before that entry exists.
- **When the worker entry lands:** `docker compose --profile worker up -d` runs it.
  Set `MIGRATE_ON_BOOT=0` on every non-primary process (already set on `worker`).
- **Multiple api replicas:** only ONE process may migrate. Run migrations as a
  one-shot before rolling the fleet (see `MIGRATION-SAFETY.md`), and set
  `MIGRATE_ON_BOOT=0` on the replicas. The migrate step also takes a Postgres
  advisory lock as a backstop.

> Runtime note: this repo runs TypeScript **directly** via Node type-stripping (no
> JS build; `apps/api "start": node src/index.ts`). The image ships the TS source +
> a pnpm-workspace `node_modules` so `@switchboard/shared` resolves through its
> symlink — the layout Node's `--experimental-strip-types` requires. The api's
> production composition root (`src/index.ts`) currently serves `/healthz` and
> migrates; wiring the full route/provider/worker graph into it is a separate
> in-flight task. The image and entrypoint host whatever `src/index.ts` grows into
> with no Dockerfile change.

## Backups & the restore drill

Nightly compressed dump with rotation (default N=14), taken **inside** the postgres
container (no published DB port), streamed to a host directory:

```bash
# Linux/macOS host:
deploy/scripts/backup.sh
# Windows host:
powershell -File deploy\scripts\backup.ps1
```

Schedule it (cron / systemd-timer / Task Scheduler), e.g.
`0 2 * * * /srv/switchboard/deploy/scripts/backup.sh >> /var/log/sb-backup.log 2>&1`.

The **restore drill** proves a backup is restorable without touching prod: it
restores the newest dump into a throwaway scratch database, runs a row-count
sanity query, prints `PASS`/`FAIL`, and drops the scratch db. Exit code 0/1 — wire
it into monitoring to catch silent backup rot.

```bash
deploy/scripts/restore.sh            # newest dump; or pass a path
powershell -File deploy\scripts\restore.ps1
```

## Upgrade runbook

1. **Back up first** — `deploy/scripts/backup.sh` (the backup is your rollback).
2. Pull the new code, rev the image tags if desired (`switchboard-api:0.1.0` →
   your new tag in `deploy/docker-compose.yml`).
3. `docker compose -f deploy/docker-compose.yml up -d --build`.
   - `api` (server role) applies pending migrations on boot behind the advisory
     lock, then serves. Follow additive-first / expand-migrate-contract discipline
     for schema changes (`MIGRATION-SAFETY.md`).
4. Watch health: `docker compose -f deploy/docker-compose.yml ps` until all
   `healthy`; `curl -fsS http://localhost:${WEB_HTTP_PORT:-8080}/healthz`.

## Rollback / restore runbook

Rolling back the **app**: redeploy the previous image tag.

Restoring the **database** (deliberate, downtime operation — the drill script is
NOT this):

1. Stop the api/worker so nothing writes:
   `docker compose -f deploy/docker-compose.yml stop api worker`.
2. Restore into prod (inside the postgres container). Example, adjusting names:
   ```bash
   docker compose -f deploy/docker-compose.yml exec -T postgres \
     pg_restore --clean --if-exists --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB" < deploy/backups/<dump>
   ```
3. Restart: `docker compose -f deploy/docker-compose.yml start api worker` and
   re-verify `/healthz`.

Point-in-time recovery beyond the last dump uses the archived WAL on the `pgwal`
volume as a base — see the Postgres PITR docs; the archive is populated by the
`archive_command` in the compose `postgres` service.

## GlitchTip (optional error tracking)

OFF by default. To enable: create a `glitchtip` database in the bundled postgres
(or point `GLITCHTIP_DB`/`DATABASE_URL` at an external one), set
`GLITCHTIP_SECRET_KEY`, then:

```bash
docker compose --profile glitchtip -f deploy/docker-compose.yml up -d
```

`glitchtip` (web + migrations) and `glitchtip-worker` (celery) share the bundled
Redis (db 1). Confirm the image tag and required env against the GlitchTip docs
for your version before relying on it in production.

## Fly.io private-app variant

ARCHITECTURE section 8 notes a Fly.io private-app option. The same api image runs
there: a Fly Postgres app + Upstash/Fly Redis, `fly deploy` building
`apps/api/Dockerfile`, `MIGRATE_ON_BOOT=1` on the primary machine, the Fly proxy
terminating TLS. The web can be a second Fly app (this nginx image) or any static
host. Not scripted here — the compose stack is the supported single-host path.

## The compose-invariants test

`deploy/` ships a vitest suite that statically asserts the deploy contract (right
services, health checks everywhere, no `:latest`, non-root, internal-only data
stores, WAL archiving) plus a script-safety smoke (`bash -n` / PowerShell parse).
It is standalone (not a pnpm-workspace member) so its dev deps stay out of the app
graph:

```bash
pnpm test:deploy        # from the repo root
```
