#!/usr/bin/env bash
# Scripted RESTORE DRILL for the Switchboard compose stack (ARCHITECTURE §8:
# "nightly pg_dump + scripted restore drill").
#
#   deploy/scripts/restore.sh [path/to/dump]     # default: newest in BACKUP_DIR
#
# This is a DRILL, not a production restore: it restores the dump into a fresh
# SCRATCH database, runs a row-count sanity query, prints a PASS/FAIL verdict,
# then drops the scratch database. It NEVER touches the production database — the
# whole point is to prove a backup is restorable without risking live data.
#
# For a real disaster recovery (overwrite prod) see deploy/README.md "Rollback /
# restore runbook" — that is a deliberate, human-run, downtime operation.
#
# Exit code: 0 on PASS, 1 on FAIL — wire it into monitoring to catch silent
# backup rot ("we had backups, they just didn't restore").
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- config (override via env) ---
BACKUP_DIR="${BACKUP_DIR:-$DEPLOY_DIR/backups}"
PGUSER="${PGUSER:-${POSTGRES_USER:-switchboard}}"
PGDATABASE="${PGDATABASE:-${POSTGRES_DB:-switchboard}}"
PG_SERVICE="${PG_SERVICE:-postgres}"
COMPOSE="${COMPOSE_CMD:-docker compose -f $DEPLOY_DIR/docker-compose.yml --env-file $DEPLOY_DIR/.env}"

# Core tables whose presence proves a meaningful restore (C1 spine).
CORE_TABLES=(users leads contacts activities)

in_pg() { $COMPOSE exec -T "$PG_SERVICE" "$@"; }
count_rows() { in_pg psql -U "$PGUSER" -d "$1" -tAc "SELECT count(*) FROM $2" 2>/dev/null | tr -d '[:space:]'; }

DUMP="${1:-$(ls -1t "$BACKUP_DIR"/switchboard-*.dump 2>/dev/null | head -n1 || true)}"
if [ -z "${DUMP:-}" ] || [ ! -f "$DUMP" ]; then
  echo "[restore] no dump found (looked in $BACKUP_DIR); pass a path explicitly" >&2
  exit 1
fi

SCRATCH="switchboard_restore_drill_$(date -u +%Y%m%d%H%M%S)"
cleanup() { in_pg dropdb -U "$PGUSER" --if-exists "$SCRATCH" >/dev/null 2>&1 || true; }
trap cleanup EXIT

verdict="PASS"
note=""

echo "[restore] drill: $DUMP -> scratch db '$SCRATCH' (prod db '$PGDATABASE' untouched)"
in_pg createdb -U "$PGUSER" "$SCRATCH"

# --no-owner/--no-privileges: the drill db need not reproduce role grants.
if ! in_pg pg_restore --no-owner --no-privileges -U "$PGUSER" -d "$SCRATCH" <"$DUMP"; then
  verdict="FAIL"
  note="pg_restore reported errors"
fi

# --- row-count sanity: every core table must be present + queryable in the
# restored db (a count(*) that errors => the restore is structurally broken).
# Counts are reported prod-vs-scratch for the operator to eyeball; parity is NOT
# a hard gate (live prod legitimately drifts ahead of an older dump).
total=0
for t in "${CORE_TABLES[@]}"; do
  prod="$(count_rows "$PGDATABASE" "$t" 2>/dev/null || echo "n/a")"
  scratch="$(count_rows "$SCRATCH" "$t" 2>/dev/null || echo "ERR")"
  echo "[restore]   $t: prod=$prod scratch=$scratch"
  if [ "$scratch" = "ERR" ] || [ -z "$scratch" ]; then
    verdict="FAIL"
    note="core table '$t' not queryable in restored db"
  else
    total=$((total + scratch))
  fi
done

echo "[restore] ================================================"
if [ "$verdict" = "PASS" ]; then
  echo "[restore] RESTORE DRILL VERDICT: PASS (core schema restored; $total rows across core tables)"
else
  echo "[restore] RESTORE DRILL VERDICT: FAIL - ${note:-unknown}"
fi
echo "[restore] ================================================"

[ "$verdict" = "PASS" ] || exit 1
