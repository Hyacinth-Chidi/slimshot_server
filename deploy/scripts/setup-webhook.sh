#!/usr/bin/env bash
# Turns on automatic deploys: a GitHub push to main runs deploy.sh.
# Run once, after the first manual deploy works:
#
#   sudo ./deploy/scripts/setup-webhook.sh
#
# It installs the `webhook` listener (Ubuntu package), creates a secret in
# /etc/slimshot/webhook.env, starts the slimshot-webhook service, and prints
# what to paste into GitHub. Re-running is safe and keeps the secret.

set -euo pipefail

die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
warn() { printf '\033[1;33mWARNING: %s\033[0m\n' "$*"; }

main() {
  [ "$(id -u)" -eq 0 ] || die "Run with sudo."
  local repo user
  repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  user="${DEPLOY_USER:-deploy}"
  id "$user" >/dev/null 2>&1 || die "No '$user' user. Run setup-vps.sh first."

  echo "==> Installing the webhook listener"
  apt-get install -y webhook jq >/dev/null
  # Ubuntu's package brings its own webhook.service (for /etc/webhook.conf); ours replaces it.
  systemctl disable --now webhook.service >/dev/null 2>&1 || true

  echo "==> The shared secret"
  install -d -m 755 /etc/slimshot
  if [ ! -s /etc/slimshot/webhook.env ]; then
    (umask 077 && printf 'WEBHOOK_SECRET=%s\n' "$(openssl rand -hex 32)" > /etc/slimshot/webhook.env)
    echo "Created /etc/slimshot/webhook.env."
  else
    echo "Keeping the existing secret."
  fi
  chmod 600 /etc/slimshot/webhook.env

  echo "==> Deploy log"
  touch /var/log/slimshot-deploy.log
  chown "$user:$user" /var/log/slimshot-deploy.log
  cat > /etc/logrotate.d/slimshot-deploy <<'EOF'
/var/log/slimshot-deploy.log {
  monthly
  rotate 6
  compress
  missingok
  notifempty
  copytruncate
}
EOF

  echo "==> The slimshot-webhook service"
  sed -e "s#__APP_DIR__#${repo}#g" -e "s#__DEPLOY_USER__#${user}#g" \
    "$repo/deploy/webhook/slimshot-webhook.service" > /etc/systemd/system/slimshot-webhook.service
  systemctl daemon-reload
  systemctl enable slimshot-webhook >/dev/null
  systemctl restart slimshot-webhook

  local code="" i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' \
      http://127.0.0.1:9000/hooks/deploy || true)"
    [ "$code" = "403" ] && break
    sleep 1
  done
  if [ "$code" = "403" ]; then
    echo "Listener is up, and it refuses unsigned requests (403), as it should."
  else
    warn "The listener did not answer as expected (got '${code}'). See: sudo journalctl -u slimshot-webhook -n 50"
  fi

  local site=/etc/nginx/sites-available/slimshot-api domain=""
  if [ -f "$site" ]; then
    domain="$(awk '/server_name/ {gsub(";", "", $2); print $2; exit}' "$site")"
    grep -q 'location /hooks/' "$site" \
      || warn "nginx has no /hooks/ route yet. Re-run: sudo ./deploy/scripts/setup-nginx.sh ${domain:-<domain>} <email>"
  else
    warn "nginx is not set up yet (setup-nginx.sh); GitHub cannot reach the listener until it is."
  fi

  cat <<EOF

Now add the webhook in GitHub:
  Repository → Settings → Webhooks → Add webhook
    Payload URL:   https://${domain:-<your-domain>}/hooks/deploy
    Content type:  application/json
    Secret:        $(cut -d= -f2- /etc/slimshot/webhook.env)
    SSL verification: Enable
    Which events:  Just the push event
    Active:        ticked

GitHub then sends a ping. Check it arrived:
  tail -n 5 /var/log/slimshot-deploy.log      # "GitHub ping received: the webhook is connected."
EOF
}

main "$@"
