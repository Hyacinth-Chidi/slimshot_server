#!/usr/bin/env bash
# Creates .env from .env.production.example with fresh random secrets:
# database and Redis passwords, JWT secrets, the identity HMAC secret and the
# master encryption key. Run once, as the deploy user, from anywhere:
#
#   ./deploy/scripts/init-env.sh
#
# Refuses to overwrite an existing .env: regenerating secrets would lock you
# out of the database and make saved provider keys unreadable.

set -euo pipefail

main() {
  cd "$(dirname "${BASH_SOURCE[0]}")/../.."
  if [ -e .env ]; then
    echo "ERROR: .env already exists. Edit it instead; it is never overwritten." >&2
    exit 1
  fi
  command -v openssl >/dev/null 2>&1 || { echo "ERROR: openssl is missing (setup-vps.sh installs it)." >&2; exit 1; }

  # Hex only: safe inside URLs (DATABASE_URL, REDIS_URL) and shells.
  local pg redis
  pg="$(openssl rand -hex 24)"
  redis="$(openssl rand -hex 24)"

  umask 077
  sed \
    -e "s/__GENERATED_POSTGRES_PASSWORD__/${pg}/g" \
    -e "s/__GENERATED_REDIS_PASSWORD__/${redis}/g" \
    -e "s/__GENERATED_JWT_ACCESS_SECRET__/$(openssl rand -hex 32)/" \
    -e "s/__GENERATED_USER_JWT_SECRET__/$(openssl rand -hex 32)/" \
    -e "s/__GENERATED_IDENTITY_HMAC_SECRET__/$(openssl rand -hex 32)/" \
    -e "s/__GENERATED_MASTER_ENCRYPTION_KEY__/$(openssl rand -hex 32)/" \
    .env.production.example > .env

  echo "Created .env (readable by you only) with fresh secrets."
  echo
  echo "Now fill in these values, then save a copy of the whole file in your password manager:"
  grep -nE '^[A-Z0-9_]+=.*CHANGE_ME' .env | sed 's/=.*//' | sed 's/^/  line /'
  echo
  echo "Edit with:  nano .env"
}

main "$@"
