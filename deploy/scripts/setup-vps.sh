#!/usr/bin/env bash
# First-time setup of a fresh Ubuntu 24.04 VPS for the SlimShot API.
# Run ONCE, as root, from the cloned repo:
#
#   sudo bash deploy/scripts/setup-vps.sh
#
# What it does (safe to re-run; every step checks before it changes anything):
#   - updates the system; installs git, nginx, certbot, rclone, fail2ban, ufw
#   - UTC clock, a 4 GB swap file, automatic security updates
#   - Docker Engine + Compose plugin, with log rotation
#   - a `deploy` user (sudo + docker) that owns the app; your SSH key and the
#     GitHub deploy key are handed over to it
#   - firewall: only SSH, HTTP and HTTPS are open
#   - SSH: key-only, no root login (only if `deploy` has a key; HARDEN_SSH=no skips it)
#   - the nightly database backup (cron, 03:15 UTC)
#
# Settings (environment variables): DEPLOY_USER (deploy), SWAP_SIZE (4G), HARDEN_SSH (yes).

set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-deploy}"
SWAP_SIZE="${SWAP_SIZE:-4G}"
HARDEN_SSH="${HARDEN_SSH:-yes}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_PARENT="$(dirname "$APP_DIR")"
BACKUP_DIR=/var/backups/slimshot

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mWARNING: %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

main() {
  [ "$(id -u)" -eq 0 ] || die "Run as root: sudo bash deploy/scripts/setup-vps.sh"
  # shellcheck disable=SC1091
  . /etc/os-release
  if [ "${ID:-}" != "ubuntu" ] || [ "${VERSION_ID:-}" != "24.04" ]; then
    warn "Written for Ubuntu 24.04; this is ${PRETTY_NAME:-unknown}. Continuing."
  fi
  export DEBIAN_FRONTEND=noninteractive

  step "Updating the system"
  apt-get update -y
  apt-get upgrade -y
  apt-get install -y ca-certificates curl gnupg git ufw fail2ban unattended-upgrades \
    nginx certbot rclone openssl jq htop

  step "Clock to UTC"
  timedatectl set-timezone UTC

  step "Swap file (${SWAP_SIZE})"
  if swapon --show=NAME --noheadings | grep -qx /swapfile; then
    echo "Swap already on."
  else
    fallocate -l "$SWAP_SIZE" /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-slimshot.conf
  sysctl --quiet -p /etc/sysctl.d/99-slimshot.conf

  step "Docker Engine and Compose"
  if ! command -v docker >/dev/null 2>&1; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -y
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
  if [ ! -f /etc/docker/daemon.json ]; then
    printf '{\n  "log-driver": "json-file",\n  "log-opts": { "max-size": "10m", "max-file": "5" }\n}\n' > /etc/docker/daemon.json
    systemctl restart docker
  fi
  systemctl enable --now docker

  step "The ${DEPLOY_USER} user"
  if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
    adduser --disabled-password --gecos "" "$DEPLOY_USER"
  fi
  usermod -aG sudo,docker "$DEPLOY_USER"
  if ! passwd -S "$DEPLOY_USER" | awk '{exit ($2 == "P") ? 0 : 1}'; then
    echo "Choose a password for ${DEPLOY_USER} (sudo asks for it; SSH will use your key):"
    passwd "$DEPLOY_USER"
  fi
  local home ssh_dir
  home="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
  ssh_dir="$home/.ssh"
  install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$ssh_dir"
  if [ -s /root/.ssh/authorized_keys ]; then
    touch "$ssh_dir/authorized_keys"
    while IFS= read -r key; do
      if [ -n "$key" ] && ! grep -qxF "$key" "$ssh_dir/authorized_keys"; then
        echo "$key" >> "$ssh_dir/authorized_keys"
      fi
    done < /root/.ssh/authorized_keys
    chmod 600 "$ssh_dir/authorized_keys"
    chown "$DEPLOY_USER:$DEPLOY_USER" "$ssh_dir/authorized_keys"
  fi
  # The read-only GitHub deploy key made while cloning (see the guide) moves to deploy.
  if [ -f /root/.ssh/github_slimshot ] && [ ! -f "$ssh_dir/github_slimshot" ]; then
    install -m 600 -o "$DEPLOY_USER" -g "$DEPLOY_USER" /root/.ssh/github_slimshot "$ssh_dir/github_slimshot"
    install -m 644 -o "$DEPLOY_USER" -g "$DEPLOY_USER" /root/.ssh/github_slimshot.pub "$ssh_dir/github_slimshot.pub"
  fi
  if [ -f "$ssh_dir/github_slimshot" ] && ! grep -q 'github_slimshot' "$ssh_dir/config" 2>/dev/null; then
    printf 'Host github.com\n  IdentityFile ~/.ssh/github_slimshot\n  IdentitiesOnly yes\n' >> "$ssh_dir/config"
    chmod 600 "$ssh_dir/config"
    chown "$DEPLOY_USER:$DEPLOY_USER" "$ssh_dir/config"
    sudo -H -u "$DEPLOY_USER" sh -c 'ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null'
  fi
  chown -R "$DEPLOY_USER:$DEPLOY_USER" "$APP_PARENT"

  step "Firewall: SSH, HTTP and HTTPS only"
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow OpenSSH
  ufw allow 'Nginx Full'
  ufw --force enable

  step "fail2ban and automatic security updates"
  systemctl enable --now fail2ban
  printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' \
    > /etc/apt/apt.conf.d/20auto-upgrades
  systemctl enable --now unattended-upgrades

  step "nginx"
  rm -f /etc/nginx/sites-enabled/default
  install -d -m 755 /var/www/certbot
  systemctl enable --now nginx

  step "Nightly database backup"
  install -d -m 750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$BACKUP_DIR"
  touch /var/log/slimshot-backup.log
  chown "$DEPLOY_USER:$DEPLOY_USER" /var/log/slimshot-backup.log
  cat > /etc/cron.d/slimshot-backup <<EOF
# Nightly Postgres backup for the SlimShot API (see docs/deploy/vps-setup.md).
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
15 3 * * * ${DEPLOY_USER} ${APP_DIR}/deploy/scripts/backup-db.sh >> /var/log/slimshot-backup.log 2>&1
EOF
  chmod 644 /etc/cron.d/slimshot-backup
  cat > /etc/logrotate.d/slimshot-backup <<'EOF'
/var/log/slimshot-backup.log {
  monthly
  rotate 6
  compress
  missingok
  notifempty
}
EOF

  step "SSH hardening"
  if [ "$HARDEN_SSH" != "yes" ]; then
    warn "Skipped (HARDEN_SSH=$HARDEN_SSH). Password and root logins stay ON."
  elif [ ! -s "$ssh_dir/authorized_keys" ]; then
    warn "Skipped: ${DEPLOY_USER} has no SSH key yet, so turning off passwords would lock you out."
    warn "Add your key (see the guide), then re-run this script."
  else
    # 00-: sshd keeps the FIRST value it reads, and cloud-init's 50-cloud-init.conf
    # often says PasswordAuthentication yes. Ours must sort before it.
    rm -f /etc/ssh/sshd_config.d/99-slimshot.conf
    cat > /etc/ssh/sshd_config.d/00-slimshot.conf <<'EOF'
# SlimShot: key-only SSH, no direct root login.
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
    sshd -t
    systemctl reload ssh
    warn "Root and password logins are now OFF. Before closing this session, open a NEW terminal and check: ssh ${DEPLOY_USER}@<server-ip>"
  fi

  step "Done"
  cat <<EOF
Next, log in as ${DEPLOY_USER} and continue with docs/deploy/vps-setup.md:
  ssh ${DEPLOY_USER}@<server-ip>
  cd ${APP_DIR}
  ./deploy/scripts/init-env.sh
EOF
}

main "$@"
