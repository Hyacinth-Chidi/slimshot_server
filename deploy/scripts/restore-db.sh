#!/usr/bin/env bash
# Replaces the live database with a backup made by backup-db.sh.
# DESTRUCTIVE: everything written since that backup is lost.
#
#   ./deploy/scripts/restore-db.sh /var/backups/slimshot/slimshot-20261005-031500.dump
#
# A dump from Google Drive: rclone copy gdrive:slimshot-backups/<file> /tmp/ first.

set -euo pipefail

main() {
  local dump="${1:-}"
  [ -n "$dump" ] && [ -s "$dump" ] || { echo "Usage: $0 <file.dump>" >&2; exit 1; }
  dump="$(cd "$(dirname "$dump")" && pwd)/$(basename "$dump")"
  cd "$(dirname "${BASH_SOURCE[0]}")/../.."
  local compose=(docker compose -f docker-compose.prod.yml)

  echo "This replaces the live database with: $dump"
  echo "Everything written since that backup will be lost."
  read -r -p "Type RESTORE to continue: " answer
  [ "$answer" = "RESTORE" ] || { echo "Cancelled."; exit 1; }

  echo "==> Taking a safety backup of the current database first"
  ./deploy/scripts/backup-db.sh

  echo "==> Stopping the API"
  "${compose[@]}" stop api

  echo "==> Restoring"
  "${compose[@]}" exec -T postgres \
    pg_restore -U slimshot -d slimshot --clean --if-exists --no-owner --single-transaction < "$dump"

  echo "==> Starting the API"
  "${compose[@]}" up -d --wait api
  echo "Restored from $dump."
}

main "$@"
