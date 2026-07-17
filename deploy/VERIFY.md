# First bring-up verification (Docker host)

The exact checklist for standing the stack up the first time on an internal Docker
host. Docker is **absent on the build machine**, so nothing below runs in CI — a
human runs it once on the target host. Steps 1–2 are verifiable **without** Docker
and are already green in the build; steps 3+ need the daemon.

Everything works with `MOCK_MODE=1` and zero external accounts. Tick items as you go.

## 0. Prerequisites

- [ ] `docker compose version` shows Compose **v2** (needed for `deploy.resources.limits` and profiles).
- [ ] This repo is on the host; you are in its root.

## 1. Config (no Docker needed)

- [ ] Copy the env template: `cp .env.example .env`
- [ ] Set **`POSTGRES_PASSWORD`** to a strong value.
- [ ] Set **`SESSION_SECRET`** to a long random value (e.g. `openssl rand -hex 32`).
- [ ] Leave `MOCK_MODE=1` for the first bring-up (no accounts required).

## 2. Static checks (no Docker needed — already green in the build)

- [ ] Run the compose-invariants + script-safety suite and expect **56 passing**
      (services / health / no-latest / non-root / WAL invariants, plus `bash -n`
      and PowerShell parse of the scripts where those interpreters exist):

```
pnpm test:deploy
```

## 3. Validate the compose file (Docker)

- [ ] The following exits 0 (variable substitution + schema validate; catches a
      missing required env like `POSTGRES_PASSWORD`):

```
docker compose --env-file .env -f deploy/docker-compose.yml config >/dev/null
```

## 4. Build + bring up

- [ ] Build and start (the api build runs `tsc --noEmit` as a gate — a type error
      fails the image):

```
docker compose --env-file .env -f deploy/docker-compose.yml up -d --build
```

- [ ] `docker compose -f deploy/docker-compose.yml ps` — `postgres`, `redis`,
      `api`, `web` all reach **healthy** (give it ~40s; api waits for DB + Redis).

## 5. Migrations applied on boot

- [ ] `docker compose -f deploy/docker-compose.yml logs api | grep migrate` shows
      `[migrate] lock acquired…` then `[migrate] up to date`.
- [ ] Confirm the journal recorded all 6 entries (expect **6**):

```
docker compose -f deploy/docker-compose.yml exec -T postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT count(*) FROM drizzle.__drizzle_migrations;"
```

## 6. Health endpoints

- [ ] api liveness through nginx returns `{ "ok": true, … }`:
      `curl -fsS http://localhost:${WEB_HTTP_PORT:-8080}/healthz`
- [ ] nginx liveness returns `ok`:
      `curl -fsS http://localhost:${WEB_HTTP_PORT:-8080}/nginx-health`
- [ ] Web shell loads in a browser at `http://<host>:${WEB_HTTP_PORT:-8080}/`
      (deep links fall back to the SPA shell).
- [ ] Security headers are present on the front door:

```
curl -sI http://localhost:${WEB_HTTP_PORT:-8080}/ \
  | grep -Ei "content-security-policy|x-content-type-options|x-frame-options"
```

## 7. Backup + restore drill (the section-8 drill)

- [ ] Take a backup — `deploy/scripts/backup.sh` (Windows:
      `powershell -File deploy\scripts\backup.ps1`). A
      `deploy/backups/switchboard-<ts>.dump` appears and passes the `pg_restore -l`
      integrity gate.
- [ ] Run the drill — `deploy/scripts/restore.sh` (Windows: `restore.ps1`). Expect
      the last line **`RESTORE DRILL VERDICT: PASS`** and exit code 0. (On a
      brand-new stack the core tables are empty; PASS means the schema restored and
      every core table is queryable — a fresh DB legitimately has 0 data rows.)

## 8. Data-store isolation (security spot-check)

- [ ] Postgres/Redis are NOT reachable from the host (no published ports) —
      `docker compose -f deploy/docker-compose.yml port postgres 5432` prints
      nothing / errors (expected).

## 9. Teardown

- [ ] `docker compose -f deploy/docker-compose.yml down` keeps volumes/data; add
      `-v` to also wipe the volumes.

---

## Notes / current state (honest)

- **App surface at bring-up:** DONE (D-044) — the composition root
  (`apps/api/src/main.ts`, run by `index.ts`) serves the full graph: migrations,
  the session-OR-bearer gate, healthz (pg + queue depth), the product-CRUD /
  inbox / smart-views / reports / bulk / admin routes, telephony + AI + token +
  webhook-CRUD, and the sequence/telephony/webhook workers. Verified in-container
  (2026-07-18): every route group reachable + correctly guarded (unauth 401,
  `/wh/twilio/*` 403 sig-check). Real provider integrations (Gmail/Twilio/
  Deepgram/Haiku, real IdP) stay unmounted until their accounts land — set
  `MOCK_MODE=0` + the credential group to enable each.
- **Worker service:** profile-gated OFF until `apps/api/src/worker.ts` exists (v1
  runs sweep/send in-process in `api`). See `README.md` → Workers.
- **Real integrations:** to turn any on, set `MOCK_MODE=0` and fill the matching
  credential group in `.env` (see the `README.md` matrix + `HUMAN_TODO.md`), then
  redeploy. Each group blocks only its own feature.
- **GlitchTip:** optional, profile `glitchtip`, requires its own DB +
  `GLITCHTIP_SECRET_KEY`.
