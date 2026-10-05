#!/usr/bin/env bash
# First-time setup of a fresh Ubuntu 24.04 VPS for the SlimShot API.
# Everything runs and is managed as root. Run from the cloned repo:
#
#   bash deploy/scripts/setup-vps.sh
#
# What it does (safe to re-run; every step checks before it changes anything):
#   - updates the system; installs git, nginx, certbot, rclone, fail2ban, ufw, jq
#   - UTC clock, a 4 GB swap file, automatic security updates
#   - Docker Engine + Compose plugin, with log rotation
#   - gives this repo its own GitHub host alias (github-slimshot), so `git pull`
#     uses its deploy key and other apps' repos can use their own keys
#   - firewall: only SSH, HTTP and HTTPS are open
#   - SSH: key-only; root may log in with a key, never a password
#     (only once root has a key; HARDEN_SSH=no skips it)
#   - the nightly database backup (cron, as root, 03:15 UTC)
#
# The server-wide parts (firewall, SSH, Docker, nginx, swap) suit other apps on
# the same VPS too; see "Hosting other apps" in docs/deploy/vps-setup.md.

set -euo pipefail

SWAP_SIZE="${SWAP_SIZE:-4G}"
HARDEN_SSH="${HARDEN_SSH:-yes}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKUP_DIR=/var/backups/slimshot
GITHUB_ALIAS=github-slimshot
DEPLOY_KEY=/root/.ssh/github_slimshot

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mWARNING: %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

main() {
  [ "$(id -u)" -eq 0 ] || die "Run as root."
  # shellcheck disable=SC1091
  . /etc/os-release
  if [ "${ID:-}" != "ubuntu" ] || [ "${VERSION_ID:-}" != "24.04" ]; then
    warn "Written for Ubuntu 24.04; this is ${PRETTY_NAME:-unknown}. Continuing."
  fi
  export DEBIAN_FRONTEND=noninteractive

  step "Updating the system"
  apt-get update -y
  apt-get -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade -y
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

  step "The app folder and its GitHub access"
  # An earlier version of this script handed the folder to a `deploy` user;
  # root manages everything now, and git refuses repos owned by another user.
  chown -R root:root "$APP_DIR"
  if [ -f "$DEPLOY_KEY" ]; then
    install -d -m 700 /root/.ssh
    touch /root/.ssh/config
    chmod 600 /root/.ssh/config
    if ! grep -q "^Host ${GITHUB_ALIAS}\$" /root/.ssh/config; then
      printf '\n# SlimShot API repo: its own deploy key (GitHub allows one repo per key).\nHost %s\n  HostName github.com\n  User git\n  IdentityFile %s\n  IdentitiesOnly yes\n' \
        "$GITHUB_ALIAS" "$DEPLOY_KEY" >> /root/.ssh/config
    fi
    grep -q '^github.com ' /root/.ssh/known_hosts 2>/dev/null \
      || ssh-keyscan -t ed25519 github.com >> /root/.ssh/known_hosts 2>/dev/null
    local url
    url="$(git -C "$APP_DIR" remote get-url origin)"
    if [[ "$url" == git@github.com:* ]]; then
      git -C "$APP_DIR" remote set-url origin "git@${GITHUB_ALIAS}:${url#git@github.com:}"
    fi
    echo "origin: $(git -C "$APP_DIR" remote get-url origin)"
  else
    warn "No $DEPLOY_KEY: if the repo is private, git pull will fail. See step 2 of the guide."
  fi

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
  install -d -m 700 -o root -g root "$BACKUP_DIR"
  touch /var/log/slimshot-backup.log
  chown root:root /var/log/slimshot-backup.log
  cat > /etc/cron.d/slimshot-backup <<EOF
# Nightly Postgres backup for the SlimShot API (see docs/deploy/vps-setup.md).
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
15 3 * * * root ${APP_DIR}/deploy/scripts/backup-db.sh >> /var/log/slimshot-backup.log 2>&1
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
    warn "Skipped (HARDEN_SSH=$HARDEN_SSH). Password logins stay ON."
  elif [ ! -s /root/.ssh/authorized_keys ]; then
    warn "Skipped: root has no SSH key yet, so turning off passwords would lock you out."
    warn "Add your key (step 1 of the guide), then re-run this script."
  else
    # 00-: sshd keeps the FIRST value it reads, and cloud-init's 50-cloud-init.conf
    # often says PasswordAuthentication yes. Ours must sort before it.
    rm -f /etc/ssh/sshd_config.d/99-slimshot.conf
    cat > /etc/ssh/sshd_config.d/00-slimshot.conf <<'EOF'
# SlimShot: key-only SSH. Root may log in with a key, never with a password.
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
    sshd -t
    systemctl reload ssh
    warn "Password logins are now OFF. Before closing this session, open a NEW terminal and check: ssh root@<server-ip> (it must not ask for a password)"
  fi

  if id deploy >/dev/null 2>&1; then
    echo
    echo "Note: an earlier version of this script created a 'deploy' user; nothing uses it now."
    echo "Remove it if you like:  deluser --remove-home deploy"
  fi

  step "Done"
  cat <<EOF
Next, as root, continue with docs/deploy/vps-setup.md step 4:
  cd ${APP_DIR}
  ./deploy/scripts/init-env.sh
EOF
}

main "$@"
