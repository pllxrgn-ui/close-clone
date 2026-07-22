#!/bin/sh
# Switchboard api/worker image entrypoint (ARCHITECTURE §8).
#
# ONE image, role chosen at runtime by APP_ROLE:
#   server (default) — optionally migrate (advisory-lock gated), then serve.
#   worker           — run the sequence sweeper/sender (see "Workers" in README).
#
# POSIX sh (the slim runtime may not ship bash). `pipefail` is a bashism, so we
# use `set -eu`; migrate.mjs and the server are single commands (no pipes) whose
# own exit codes propagate.
set -eu

ROLE="${APP_ROLE:-server}"
APP_DIR="/app/apps/api"
# TS runs directly via Node type-stripping (the repo emits no JS — see
# apps/api "start": node src/index.ts). Flag kept explicit for Node 22.x.
NODE_TS="node --experimental-strip-types"
export MIGRATIONS_DIR="${MIGRATIONS_DIR:-$APP_DIR/src/db/migrations}"

run_migrations() {
  echo "[entrypoint] migrating (advisory-lock gated)…"
  node "$APP_DIR/migrate.mjs"
  echo "[entrypoint] migrations complete"
}

case "$ROLE" in
server)
  if [ "${MIGRATE_ON_BOOT:-1}" != "0" ]; then
    run_migrations
  else
    echo "[entrypoint] MIGRATE_ON_BOOT=0 — skipping migrations"
  fi
  echo "[entrypoint] starting api server on :${PORT:-3000}"
  # shellcheck disable=SC2086
  exec $NODE_TS "$APP_DIR/src/index.ts"
  ;;
worker)
  # Liveness heartbeat for the compose healthcheck (updated every 30s).
  ( while true; do touch /tmp/worker-alive; sleep 30; done ) &
  echo "[entrypoint] starting worker"
  # shellcheck disable=SC2086
  exec $NODE_TS "$APP_DIR/src/index.ts"
  ;;
*)
  echo "[entrypoint] unknown APP_ROLE='$ROLE' (expected server|worker)" >&2
  exit 1
  ;;
esac
