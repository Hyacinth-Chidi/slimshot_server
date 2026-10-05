#!/usr/bin/env bash
# Dumps the Postgres database to /var/backups/slimshot and, when rclone is set
# up, copies it to Google Drive. Cron runs it nightly at 03:15 UTC (installed by
# setup-vps.sh); run it by hand any time as root:
#
#   ./deploy/scripts/backup-db.sh
#
# Settings (environment variables):
#   BACKUP_DIR        /var/backups/slimshot
#   KEEP_DAYS         14   local dumps older than this are deleted
#   RCLONE_REMOTE     gdrive:slimshot-backups   (remote:folder; see the guide)
#   REMOTE_KEEP_DAYS  30   Drive copies older than this are deleted

set -euo pipefail

main() {
  cd "$(dirname "${BASH_SOURCE[0]}")/../.."
  local dir="${BACKUP_DIR:-/var/backups/slimshot}"
  local keep="${KEEP_DAYS:-14}"
  local remote="${RCLONE_REMOTE:-gdrive:slimshot-backups}"
  local remote_keep="${REMOTE_KEEP_DAYS:-30}"
  local file
  file="$dir/slimshot-$(date -u +%Y%m%d-%H%M%S).dump"

  mkdir -p "$dir"
  echo "$(date -u +%FT%TZ) backup start"
  # Custom format (-Fc) is compressed and restores with pg_restore.
  docker compose -f docker-compose.prod.yml exec -T postgres \
    pg_dump -U slimshot -d slimshot -Fc > "$file.partial"
  [ -s "$file.partial" ] || { echo "ERROR: empty dump" >&2; rm -f "$file.partial"; exit 1; }
  mv "$file.partial" "$file"
  chmod 600 "$file"
  echo "saved $file ($(du -h "$file" | cut -f1))"

  find "$dir" -name 'slimshot-*.dump' -mtime +"$keep" -delete

  if rclone listremotes 2>/dev/null | grep -qx "${remote%%:*}:"; then
    rclone copy "$file" "$remote"
    rclone delete --min-age "${remote_keep}d" "$remote"
    echo "copied to $remote"
  else
    echo "WARNING: rclone remote '${remote%%:*}' is not set up; this dump stays on the VPS only." >&2
  fi
  echo "$(date -u +%FT%TZ) backup done"
}

main "$@"
