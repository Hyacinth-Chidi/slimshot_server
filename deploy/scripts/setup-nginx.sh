#!/usr/bin/env bash
# Puts the API behind nginx with a free Let's Encrypt certificate.
# Run once the domain's DNS points at this VPS:
#
#   sudo ./deploy/scripts/setup-nginx.sh slimshot-server.techfamz.com you@example.com
#
# Re-running it is safe: it keeps an existing certificate and just reinstalls
# the nginx config from the repo (do that after changing deploy/nginx/*).
# Renewal is automatic (certbot's systemd timer) and reloads nginx.

set -euo pipefail

die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

main() {
  [ "$(id -u)" -eq 0 ] || die "Run with sudo."
  local domain="${1:-}" email="${2:-}"
  [ -n "$domain" ] && [ -n "$email" ] || die "Usage: sudo $0 <domain> <email for Let's Encrypt notices>"

  local repo
  repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  local available=/etc/nginx/sites-available/slimshot-api
  local enabled=/etc/nginx/sites-enabled/slimshot-api

  # The domain must already point here, or Let's Encrypt cannot reach us.
  local here there
  here="$(curl -fsS -4 https://api.ipify.org || true)"
  there="$(getent ahostsv4 "$domain" | awk 'NR==1 {print $1}' || true)"
  if [ -z "$there" ]; then
    die "$domain does not resolve yet. Create its A record (see the guide) and wait for it to appear."
  fi
  if [ -n "$here" ] && [ "$here" != "$there" ]; then
    die "$domain points to $there, but this VPS is $here. Fix the A record first."
  fi

  install -d -m 755 /var/www/certbot
  install -m 644 "$repo/deploy/nginx/proxy-params.conf" /etc/nginx/snippets/slimshot-proxy.conf

  if [ ! -f "/etc/letsencrypt/live/$domain/fullchain.pem" ]; then
    echo "==> Requesting a certificate for $domain"
    sed "s/__DOMAIN__/$domain/g" "$repo/deploy/nginx/acme-only.conf" > "$available"
    ln -sf "$available" "$enabled"
    nginx -t
    systemctl reload nginx
    certbot certonly --webroot -w /var/www/certbot -d "$domain" \
      --email "$email" --agree-tos --no-eff-email --non-interactive \
      --deploy-hook "systemctl reload nginx"
  else
    echo "==> Certificate for $domain already present; keeping it."
  fi

  echo "==> Installing the HTTPS site"
  sed "s/__DOMAIN__/$domain/g" "$repo/deploy/nginx/slimshot-api.conf" > "$available"
  ln -sf "$available" "$enabled"
  nginx -t
  systemctl reload nginx

  echo "==> Checking automatic renewal"
  if certbot renew --dry-run --quiet; then
    echo "Renewal works."
  else
    echo "WARNING: the renewal dry run failed; check 'sudo certbot renew --dry-run' before the certificate expires." >&2
  fi

  echo
  echo "nginx now serves https://$domain and forwards to the API on 127.0.0.1:2700."
  echo "Until the first deploy it answers 502; run ./deploy/scripts/deploy.sh next."
}

main "$@"
