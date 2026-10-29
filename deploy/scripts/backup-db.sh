#!/usr/bin/env bash
# Saves a copy of the live database to /var/backups/slimshot. restore-db.sh runs it
# as a safety copy before it replaces the database; run it by hand any time as root:
#
#   ./deploy/scripts/backup-db.sh
#
# Backups proper go to the private R2 bucket from the API: System › Backups in the
# dashboard makes them on demand and on a schedule.
#
# Settings (environment variables):
#   BACKUP_DIR  /var/backups/slimshot
#   KEEP_DAYS   14   local copies older than this are deleted

set -euo pipefail

main() {
  cd "$(dirname "${BASH_SOURCE[0]}")/../.."
  local dir="${BACKUP_DIR:-/var/backups/slimshot}"
  local keep="${KEEP_DAYS:-14}"
  local file
  file="$dir/slimshot-$(date -u +%Y%m%d-%H%M%S).dump"

  # The dump holds every account: private from the moment it exists.
  umask 077
  mkdir -p "$dir"
  echo "$(date -u +%FT%TZ) backup start"
  # Custom format (-Fc) is compressed and restores with pg_restore.
  docker compose -f docker-compose.yml exec -T postgres \
    pg_dump -U slimshot -d slimshot -Fc > "$file.partial"
  [ -s "$file.partial" ] || { echo "ERROR: empty dump" >&2; rm -f "$file.partial"; exit 1; }
  mv "$file.partial" "$file"
  chmod 600 "$file"
  echo "saved $file ($(du -h "$file" | cut -f1))"

  find "$dir" -name 'slimshot-*.dump' -mtime +"$keep" -delete
  echo "$(date -u +%FT%TZ) backup done"
}

main "$@"
