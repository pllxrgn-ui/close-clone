#!/usr/bin/env bash
# Nightly Postgres backup for the Switchboard compose stack (ARCHITECTURE §8).
#
#   deploy/scripts/backup.sh
#
# Takes a compressed custom-format dump (pg_dump -Fc) of the live database and
# rotates old dumps, keeping the newest N (default 14 → two weeks of nightlies).
# Runs pg_dump INSIDE the postgres container via `docker compose exec` so the DB
# never needs a published host port; the dump streams out to a host directory.
#
# Schedule from cron/systemd-timer/Task Scheduler, e.g.:
#   0 2 * * *  /srv/switchboard/deploy/scripts/backup.sh >> /var/log/sb-backup.log 2>&1
#
# Restores + the verification drill: deploy/scripts/restore.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- config (override via env) ---
BACKUP_DIR="${BACKUP_DIR:-$DEPLOY_DIR/backups}"
RETENTION="${BACKUP_RETENTION:-14}" # nightly dumps to keep
PGUSER="${PGUSER:-${POSTGRES_USER:-switchboard}}"
PGDATABASE="${PGDATABASE:-${POSTGRES_DB:-switchboard}}"
PG_SERVICE="${PG_SERVICE:-postgres}"
COMPOSE="${COMPOSE_CMD:-docker compose -f $DEPLOY_DIR/docker-compose.yml --env-file $DEPLOY_DIR/.env}"

# Run a pg client tool inside the postgres container (stdin/stdout streamed).
in_pg() { $COMPOSE exec -T "$PG_SERVICE" "$@"; }

timestamp="$(date -u +%Y%m%d-%H%M%SZ)"
dest="$BACKUP_DIR/switchboard-$timestamp.dump"
mkdir -p "$BACKUP_DIR"

echo "[backup] pg_dump -Fc db=$PGDATABASE -> $dest"
# -Fc: compressed custom format — selective, parallelisable pg_restore.
in_pg pg_dump -Fc -U "$PGUSER" -d "$PGDATABASE" >"$dest"

# Integrity gate: a valid custom-format archive lists its table of contents.
if ! in_pg pg_restore -l <"$dest" >/dev/null 2>&1; then
  echo "[backup] FAILED integrity check (pg_restore -l); removing $dest" >&2
  rm -f "$dest"
  exit 1
fi
size="$(wc -c <"$dest" | tr -d ' ')"
echo "[backup] ok (${size} bytes)"

# --- rotation: keep the newest $RETENTION dumps, delete older ---
echo "[backup] rotation: keep newest $RETENTION"
# ls -t = newest first; tail -n +N+1 = everything past the retention window.
ls -1t "$BACKUP_DIR"/switchboard-*.dump 2>/dev/null | tail -n "+$((RETENTION + 1))" | while IFS= read -r old; do
  echo "[backup] rotate: rm $old"
  rm -f "$old"
done

echo "[backup] done"
