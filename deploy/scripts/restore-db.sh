#!/usr/bin/env bash
# Restores a database backup. Run as root, from anywhere:
#
#   ./deploy/scripts/restore-db.sh '<link>'           # the command System › Backups gives you
#   ./deploy/scripts/restore-db.sh --check '<link>'   # rehearsal: nothing live is touched
#   ./deploy/scripts/restore-db.sh /var/backups/slimshot/slimshot-20261005-031500.dump
#
# A link from System › Backups › Copy restore command lasts an hour.
#
# How it works: the backup is restored into a new database, slimshot_restore, beside
# the live one, and the migrations bring it up to the current schema. Only then is the
# API stopped and the two databases swapped, and the API restarted on the restored one.
# If anything fails before the swap, nothing live was touched. If the API won't start
# on the restored database, the original is put back. The previous database is kept as
# slimshot_before_restore_<time> until you drop it; the last line says how.
#
# Without --check this is DESTRUCTIVE: everything written since the backup leaves the
# live database. A safety copy of it is saved to /var/backups/slimshot first.

set -euo pipefail

readonly DB=slimshot
readonly RESTORE_DB=slimshot_restore
readonly COMPOSE=(docker compose -f docker-compose.yml)

# How far the script got, so cleanup() can put things right if it stops early.
DOWNLOAD=""     # the temp file a link was downloaded to
RESTORE_OURS=0  # slimshot_restore exists and is ours to drop
API_STOPPED=0   # the API is stopped and must be started again
OLD_DB=""       # where the live database was renamed to, until it is safely in place
SWAPPED=0       # the restored database is now called slimshot
DONE=0          # finished: nothing to put right

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mWARNING: %s\033[0m\n' "$*" >&2; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# SQL as the superuser, from the maintenance database: a database can't be renamed
# or dropped by a session connected to it.
admin_sql() {
  "${COMPOSE[@]}" exec -T postgres psql -U slimshot -d postgres -v ON_ERROR_STOP=1 -qAt "$@"
}

end_connections() {
  admin_sql -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('$1', '$2') AND pid <> pg_backend_pid();" >/dev/null
}

env_value() {
  grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- | tr -d "\"'\r" || true
}

cleanup() {
  # A second Ctrl-C, or the SSH session dropping, must not stop the putting-right halfway.
  trap '' INT TERM HUP
  set +e
  [ -n "$DOWNLOAD" ] && rm -f "$DOWNLOAD"
  # DONE, not $?: after a hangup, bash runs this with a stale exit status of 0.
  [ "$DONE" -eq 1 ] && return
  if [ -n "$OLD_DB" ] && [ "$SWAPPED" -eq 0 ]; then
    warn "Stopped mid-swap: renaming $OLD_DB back to $DB."
    admin_sql -c "ALTER DATABASE $OLD_DB RENAME TO $DB;"
  fi
  if [ "$RESTORE_OURS" -eq 1 ]; then
    admin_sql -c "DROP DATABASE IF EXISTS $RESTORE_DB WITH (FORCE);" >/dev/null
  fi
  if [ "$API_STOPPED" -eq 1 ]; then
    warn "Starting the API again."
    "${COMPOSE[@]}" up -d api
  fi
}

download() {
  DOWNLOAD="$(mktemp -t slimshot-restore-XXXXXX)" # 0600
  step "Downloading the backup"
  if ! curl -fsS --proto =https --retry 3 -o "$DOWNLOAD" "$1"; then
    die "The download failed. A restore link lasts an hour: copy a fresh one from System › Backups."
  fi
}

applied_migrations() {
  "${COMPOSE[@]}" exec -T postgres psql -U slimshot -d "$1" -v ON_ERROR_STOP=1 -qAt -c \
    'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;' |
    LC_ALL=C sort
}

# Every migration the live database has must be in the restored one too. If the migrate
# run had reached the wrong database, the swap would put an older table layout under
# newer code, and the API would only fail later, on the first query that needs it.
check_migrations() {
  local live restored missing
  live="$(applied_migrations "$DB")" || die "Could not read the live database's migrations."
  restored="$(applied_migrations "$RESTORE_DB")" || die "Could not read the restored database's migrations (step 4)."
  missing="$(LC_ALL=C comm -23 <(printf '%s\n' "$live") <(printf '%s\n' "$restored") | grep -v '^$' || true)"
  [ -z "$missing" ] || die "The restored database lacks migrations the live one has (step 4): $(echo "$missing" | tr '\n' ' ')Nothing live was touched."
}

# Ready, not just alive: /health/ready also checks the database, Redis and storage.
api_ready() {
  local port
  port="$(env_value PORT)"
  curl -fsS -o /dev/null --retry 5 --retry-delay 2 --retry-all-errors "http://127.0.0.1:${port:-2700}/health/ready"
}

# Steps 3 and 4: the backup, restored beside the live database and migrated.
build_restored_database() {
  local dump="$1" password
  password="$(env_value POSTGRES_PASSWORD)"
  [ -n "$password" ] || die "POSTGRES_PASSWORD is missing from .env."

  step "Restoring the backup into $RESTORE_DB, beside the live database"
  admin_sql -c "DROP DATABASE IF EXISTS $RESTORE_DB WITH (FORCE);" >/dev/null
  admin_sql -c "CREATE DATABASE $RESTORE_DB OWNER slimshot;" >/dev/null
  RESTORE_OURS=1
  if ! "${COMPOSE[@]}" exec -T postgres \
    pg_restore -U slimshot -d "$RESTORE_DB" --no-owner --single-transaction <"$dump"; then
    die "The backup could not be restored (step 3). Nothing live was touched."
  fi

  step "Bringing $RESTORE_DB up to the current schema"
  # The address goes through the environment: on the command line, ps would show the password.
  if ! DATABASE_URL="postgresql://slimshot:${password}@postgres:5432/${RESTORE_DB}" \
    "${COMPOSE[@]}" --profile tools run --rm -e DATABASE_URL migrate; then
    die "The migrations failed on the restored database (step 4). Nothing live was touched."
  fi
  check_migrations
}

swap_in_restored() {
  end_connections "$DB" "$RESTORE_DB"
  admin_sql -c "ALTER DATABASE $DB RENAME TO $1;"
  OLD_DB="$1"
  admin_sql -c "ALTER DATABASE $RESTORE_DB RENAME TO $DB;"
  SWAPPED=1
  RESTORE_OURS=0
}

# The restored database goes back to slimshot_restore, kept to look into.
put_original_back() {
  end_connections "$DB" "$OLD_DB"
  admin_sql -c "ALTER DATABASE $DB RENAME TO $RESTORE_DB;"
  SWAPPED=0
  admin_sql -c "ALTER DATABASE $OLD_DB RENAME TO $DB;"
  OLD_DB=""
}

main() {
  local check=0
  if [ "${1:-}" = "--check" ]; then
    check=1
    shift
  fi
  local source="${1:-}" dump name
  [ $# -eq 1 ] && [ -n "$source" ] || {
    echo "Usage: $0 [--check] <file.dump | https://link>" >&2
    exit 1
  }
  if [[ "$source" != https://* ]]; then
    [ -s "$source" ] || die "No backup at $source"
    source="$(cd "$(dirname "$source")" && pwd)/$(basename "$source")"
  fi
  name="${source%%\?*}"
  name="${name##*/}"

  cd "$(dirname "${BASH_SOURCE[0]}")/../.."
  # deploy.sh takes the same lock: a deploy can't restart the API in the middle of this.
  exec 9>.deploy.lock
  flock -n 9 || die "A deploy is running. Run this again once it has finished."

  trap cleanup EXIT
  trap 'exit 130' INT TERM
  trap 'exit 129' HUP

  if [[ "$source" == https://* ]]; then
    download "$source"
    dump="$DOWNLOAD"
  else
    dump="$source"
  fi
  [ -s "$dump" ] || die "The backup is empty."

  if [ "$check" -eq 1 ]; then
    build_restored_database "$dump"
    step "What the backup holds"
    "${COMPOSE[@]}" exec -T postgres psql -U slimshot -d "$RESTORE_DB" -v ON_ERROR_STOP=1 -P pager=off -c \
      'SELECT (SELECT count(*) FROM "User") AS users, (SELECT count(*) FROM "Asset") AS assets, (SELECT count(*) FROM "CreditTransaction") AS credit_transactions;'
    admin_sql -c "DROP DATABASE $RESTORE_DB WITH (FORCE);" >/dev/null
    RESTORE_OURS=0
    DONE=1
    echo
    echo "$name restores and migrates cleanly. Nothing live was touched."
    return
  fi

  echo "This replaces the live database with the backup $name."
  echo "Everything written since that backup will be lost (a safety copy is saved first)."
  read -r -p "Type RESTORE to continue: " answer
  [ "$answer" = "RESTORE" ] || {
    echo "Cancelled."
    exit 1
  }

  step "Taking a safety backup of the current database"
  ./deploy/scripts/backup-db.sh

  build_restored_database "$dump"

  step "Stopping the API"
  API_STOPPED=1
  "${COMPOSE[@]}" stop api

  local old
  old="slimshot_before_restore_$(date -u +%Y%m%d_%H%M%S)"
  step "Swapping in the restored database (the current one becomes $old)"
  swap_in_restored "$old"

  step "Starting the API on the restored database"
  if ! "${COMPOSE[@]}" up -d --wait --wait-timeout 120 api || ! api_ready; then
    "${COMPOSE[@]}" logs --tail=40 api || true
    step "The API did not become ready: putting the original database back"
    "${COMPOSE[@]}" stop api
    put_original_back
    "${COMPOSE[@]}" up -d --wait --wait-timeout 120 api && API_STOPPED=0
    die "Restore undone: the API runs on the original database again. The restored copy is kept as $RESTORE_DB to look into (drop it with: docker compose -f docker-compose.yml exec postgres dropdb -U slimshot $RESTORE_DB)."
  fi
  API_STOPPED=0
  OLD_DB=""
  DONE=1

  echo
  echo "Restored from $name. The API is running on it."
  echo "The previous database is kept as $old. Once you're sure you don't need it:"
  echo "  docker compose -f docker-compose.yml exec postgres dropdb -U slimshot $old"
}

main "$@"
