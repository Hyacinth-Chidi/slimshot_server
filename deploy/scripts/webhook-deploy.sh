#!/usr/bin/env bash
# Run (as root, through one sudo rule) by the webhook listener
# (deploy/webhook/hooks.json) once GitHub's signature has checked out.
# Deploys pushes to main; logs and ignores the rest. Arguments, from GitHub's
# request: event, ref, commit, pusher. Everything goes to the deploy log:
#
#   tail -f /var/log/slimshot-deploy.log
#
# GitHub has already had its answer by the time this runs, so a failed deploy
# shows here, not in GitHub's webhook page.

set -uo pipefail

LOG="${DEPLOY_LOG:-/var/log/slimshot-deploy.log}"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }

main() {
  cd "$(dirname "${BASH_SOURCE[0]}")/../.."
  local event="${1:-}" ref="${2:-}" sha="${3:-}" who="${4:-someone}" branch="${DEPLOY_BRANCH:-main}"

  case "$event" in
    ping)
      log "GitHub ping received: the webhook is connected."
      return 0
      ;;
    push) ;;
    *)
      log "Ignored a '${event:-unknown}' event."
      return 0
      ;;
  esac

  if [ "$ref" != "refs/heads/$branch" ]; then
    log "Ignored a push to ${ref#refs/heads/} (only $branch deploys)."
    return 0
  fi
  if [ -z "$sha" ] || [ "$sha" = "0000000000000000000000000000000000000000" ]; then
    log "Ignored: the push to $branch carried no commit."
    return 0
  fi

  log "Push of ${sha:0:7} to $branch by $who: deploying."
  if ./deploy/scripts/deploy.sh; then
    log "Deploy of ${sha:0:7} finished."
  else
    log "DEPLOY FAILED for ${sha:0:7}. The output is above; the API may be down until it is fixed."
  fi
}

main "$@" >> "$LOG" 2>&1
