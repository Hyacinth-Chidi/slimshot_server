#!/usr/bin/env bash
# Deploys the latest code. Run as root, from anywhere:
#
#   ./deploy/scripts/deploy.sh
#
#   1. git pull (fast-forward only; SKIP_PULL=1 skips it)
#   2. build the images
#   3. start Postgres and Redis, wait until healthy
#   4. apply database migrations and the idempotent seed
#   5. restart the API and wait for its health check
#   6. remove old images
#
# If the API fails its health check, the script prints its last log lines and
# exits non-zero. Postgres and Redis keep running; nothing is deleted.

set -euo pipefail

die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

# Everything runs inside main() so bash reads the whole file before `git pull`
# can change it underneath.
main() {
  cd "$(dirname "${BASH_SOURCE[0]}")/../.."
  local compose=(docker compose -f docker-compose.yml)

  # One deploy at a time: a webhook deploy and a manual one wait for each other.
  exec 9>.deploy.lock
  if ! flock -n 9; then
    echo "Another deploy is running; waiting for it to finish…"
    flock 9
  fi

  [ -f .env ] || die "No .env yet. Run ./deploy/scripts/init-env.sh and fill it in."
  if grep -nE '^[A-Z0-9_]+=.*(CHANGE_ME|__GENERATED_[A-Z_]+__)' .env; then
    die "Fill in the values listed above in .env first."
  fi

  if [ "${SKIP_PULL:-0}" != "1" ]; then
    step "Pulling the latest code"
    git pull --ff-only
  fi
  step "Deploying $(git log -1 --format='%h %s')"

  step "Building images"
  "${compose[@]}" --profile tools build

  step "Starting Postgres and Redis"
  "${compose[@]}" up -d --wait postgres redis

  step "Applying database migrations"
  "${compose[@]}" --profile tools run --rm migrate

  step "Restarting the API"
  if ! "${compose[@]}" up -d --wait --wait-timeout 120 api; then
    "${compose[@]}" logs --tail=80 api || true
    die "The API did not become healthy. Its last log lines are above."
  fi

  step "Checking the API"
  local port
  port="$(grep -E '^PORT=' .env | cut -d= -f2 | tr -d '"' || true)"
  curl -fsS "http://127.0.0.1:${port:-2700}/health/ready" && echo

  step "Removing old images"
  docker image prune -f >/dev/null

  echo
  echo "Deployed $(git log -1 --format='%h')."
}

main "$@"
