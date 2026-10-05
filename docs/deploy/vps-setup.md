# Hosting the SlimShot API on the VPS

This guide sets up the Contabo VPS (Ubuntu 24.04, 4 vCPU, 8 GB RAM) to serve the API at
**https://slimshot-server.techfamz.com**. You do the first setup once (about 45 minutes).
After that, deploying new code is one command, or automatic on push (step 9).

```
                      ┌──────────────────────────── VPS ────────────────────────────┐
 phone / dashboard ──▶│ nginx :443 (Let's Encrypt) ──▶ 127.0.0.1:2700 ──▶ api        │
        HTTPS         │                                                  ├─▶ postgres │
                      │   firewall: only 22, 80, 443 open                └─▶ redis    │
                      └──────────────────────────────────────────────────────────────┘
```

- **nginx** and **certbot** run on the VPS itself: HTTPS, the free certificate and its renewal.
- **Docker Compose** runs three containers: the API, Postgres 17 and Redis 7. Postgres
  and Redis are on a private network and cannot be reached from the internet.
- **Everything is managed as root.** SSH accepts root with a key, never with a password.
- The database starts empty. Migrations build it, and the first owner account comes
  from `.env`.
- The VPS can host other apps too; see "Hosting other apps on this VPS" near the end.

Commands marked **PC** run in PowerShell on your computer. The others run on the VPS, as root.

### The order at a glance

| Step | Where | What | When |
|---|---|---|---|
| 0 | PC, DNS, GitHub | DNS record, push `main`, gather the `.env` values | once |
| 1 | PC | SSH key login for root | once (skip if root already logs in without a password) |
| 2 | VPS | Deploy key, clone into `/var/www/slimshot_server` | once |
| 3 | VPS | `setup-vps.sh`: firewall, Docker, nginx, key-only SSH, backups | once |
| 4 | VPS | `.env`: generate one, or bring yours from the PC | once |
| 5 | VPS | `setup-nginx.sh`: HTTPS certificate | once |
| 6 | VPS | `deploy.sh`: first deploy, then check `/health` | once |
| 7 | Dashboard, AdMob, Play Console | Point everything at the live API | once |
| 8 | VPS and PC | Google Drive backups (`rclone`) | once |
| 9 | VPS and GitHub | Automatic deploys on push (webhook) | once, optional |
| 10 | VPS | Everyday commands | as needed |

---

## 0. Before you start

You need:

1. **The VPS's IP address and root password**, from Contabo's welcome email.
2. **The DNS record.** Where `techfamz.com`'s DNS is managed, add an **A record**:
   `slimshot-server` → *the VPS IP*. Check it (**PC**):
   ```powershell
   nslookup slimshot-server.techfamz.com
   ```
   It must answer with the VPS IP before step 5. Don't add an AAAA (IPv6) record unless you
   set up IPv6 on the VPS.
3. **`main` pushed to GitHub.** The VPS clones from GitHub, so the deploy files must be there:
   ```powershell
   cd "C:\Users\HP\Desktop\Slimshot workspace\slimshot_server"
   git push origin main
   ```
4. **The values for `.env`.** Each one is explained in step 4:
   - your Cloudinary keys;
   - the Google OAuth **Web** client ID;
   - your SMTP login;
   - your AdMob rewarded ad unit ID;
   - an email and a strong password for the first owner account;
   - the dashboard's address.
5. **An email address** for Let's Encrypt's expiry notices.

## 1. Your SSH key for root (PC)

A key lets you log in without a password; step 3 then turns password logins off, which stops
the bots that guess root passwords all day.

> **Already logging in as root?** Run `ssh root@VPS_IP` once more. If it lets you in
> **without** asking for a password, you already have a key: skip to step 2. If it asks for
> the password, do this step, or step 3 will leave password logins on.

```powershell
ssh-keygen -t ed25519 -C "slimshot-vps"
# Press Enter to accept the default file; a passphrase is optional but recommended.

type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh root@VPS_IP "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"

ssh root@VPS_IP
```

The last command must log you in **without** asking for the root password. If it still asks,
the key wasn't added: repeat the `type …` line.

## 2. Get the code onto the VPS

The VPS gets its own **read-only deploy key** for the repository. That works whether the repo
is private or public, and the key can pull but never push:

```bash
apt-get update && apt-get install -y git
ssh-keygen -t ed25519 -f /root/.ssh/github_slimshot -N "" -C "slimshot-vps"
cat /root/.ssh/github_slimshot.pub
```

Copy the line it prints. On GitHub, open **Hyacinth-Chidi/slimshot_server → Settings → Deploy
keys → Add deploy key**, paste it, name it `slimshot-vps`, and leave **Allow write access**
off.

Check GitHub accepts the key. It must greet the repository by name:

```bash
ssh -i /root/.ssh/github_slimshot -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -T git@github.com
# Hi Hyacinth-Chidi/slimshot_server! You've successfully authenticated, but GitHub does not provide shell access.
```

If it says `Permission denied (publickey)`, the key isn't on the repository's **Deploy keys**
page yet: paste `cat /root/.ssh/github_slimshot.pub` there.

The app lives in **`/var/www/slimshot_server`**. `export` makes git use the deploy key for
the rest of this session, so the lines work even when pasted one at a time:

```bash
mkdir -p /var/www && cd /var/www
export GIT_SSH_COMMAND="ssh -i /root/.ssh/github_slimshot -o IdentitiesOnly=yes"
git clone git@github.com:Hyacinth-Chidi/slimshot_server.git
cd slimshot_server
```

Keep the word `export`. Without it, the setting doesn't reach `git` and the clone fails with
`Permission denied (publickey)` even though the key works. You need it only for this first
clone: step 3 points the repo at its own GitHub alias (`github-slimshot`), so every later
`git pull` uses the key by itself.

nginx doesn't read this folder: it forwards requests to the API container. Any other folder
works too, because every script finds its own location.

> **Everything the server needs comes from this clone** (and later `git pull`): the code, the
> `Dockerfile`, `docker-compose.prod.yml`, the nginx config and every script. Nothing is
> copied from your PC except **`.env`**, the one git-ignored file that holds the secrets
> (step 4). `node_modules` and `dist` aren't needed: the Docker image builds them on the VPS.

## 3. First-time server setup

```bash
cd /var/www/slimshot_server
bash deploy/scripts/setup-vps.sh
```

It takes about 5 minutes. If the upgrade stops on a screen about a configuration file or
"services to restart", press **Enter** for the default. The script:

- updates the system;
- installs Docker, nginx, certbot, rclone and fail2ban;
- adds a 4 GB swap file and sets the clock to UTC;
- turns on automatic security updates;
- points the repo at the `github-slimshot` alias (in `/root/.ssh/config`), so `git pull` uses the deploy key;
- opens only ports 22, 80 and 443;
- installs the nightly backup;
- finally makes SSH key-only: root may log in with a key, never with a password.

At the end, the **SSH hardening** part says one of two things:

| It says | What to do |
|---|---|
| `Password logins are now OFF…` | **Before closing this window**, open a new PowerShell and run `ssh root@VPS_IP`. It must log you in without a password |
| `Skipped: root has no SSH key yet…` | Do step 1, then run `bash deploy/scripts/setup-vps.sh` again. It's safe to re-run |

If you ever lock yourself out, Contabo's control panel has a **VNC console**: log in there
as root with the root password (passwords still work on the console, just not over SSH).

> **Ran an earlier version of this script?** It created a `deploy` user and gave it the app
> folder. Pull the new scripts and re-run; it hands the folder back to root and moves the
> backup job to root:
> ```bash
> cd /var/www/slimshot_server
> chown -R root:root /var/www/slimshot_server
> export GIT_SSH_COMMAND="ssh -i /root/.ssh/github_slimshot -o IdentitiesOnly=yes"
> git pull
> bash deploy/scripts/setup-vps.sh
> deluser --remove-home deploy        # optional: nothing uses it any more
> ```

## 4. Settings: `.env`

`.env` is git-ignored, so it never comes with the clone: it's the only file you provide
yourself. Use **one** of the two ways below.

### 4A. Generate a new `.env` (recommended)

```bash
./deploy/scripts/init-env.sh
nano .env
```

`init-env.sh` creates `.env` with fresh random values for:
- the database and Redis passwords;
- both token secrets;
- the identity secret;
- the encryption key.

Replace every `CHANGE_ME`:

| Variable | What to put |
|---|---|
| `ADMIN_BASE_URL` | Already `https://slimshot-admin.techfamz.com`, the dashboard on this VPS. To use a dashboard running on your PC, add `http://localhost:3001` to `CORS_ALLOWED_ORIGINS` |
| `ADMIN_BOOTSTRAP_EMAIL` / `ADMIN_BOOTSTRAP_PASSWORD` | The first owner account, created on the first start |
| `CLOUDINARY_CLOUD_NAME` / `_API_KEY` / `_API_SECRET` | Cloudinary dashboard → API Keys |
| `GOOGLE_CLIENT_IDS` | Google Cloud → Credentials → the OAuth **Web** client ID |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM` | Your mail provider. Port 587 goes with `SMTP_SECURE=false`; port 465 with `SMTP_SECURE=true` |
| `ADMOB_AD_UNIT_IDS` | AdMob → your app → Ad units → the **rewarded** unit's ID (`ca-app-pub-…/…`). **Required:** the server won't start in production without it, so create the ad unit first |

Save with **Ctrl+O**, **Enter**, then exit with **Ctrl+X**.

### 4B. Bring the `.env` from your PC

If your PC's `.env` already holds the Docker database and Redis lines (`POSTGRES_PASSWORD`,
`DATABASE_URL=…@postgres:5432/…`, `REDIS_PASSWORD`, `REDIS_URL=…@redis:6379`), copy it
instead (**PC**):

```powershell
scp "C:\Users\HP\Desktop\Slimshot workspace\slimshot_server\.env" root@VPS_IP:/var/www/slimshot_server/.env
```

Then on the VPS: `chmod 600 .env` and `nano .env`, and change these for production:

| Line | Production value |
|---|---|
| `NODE_ENV` | `production` (add the line if it's missing) |
| `TRUST_PROXY` | `1` |
| `EMAIL_SENDER` | `smtp`, with a matching `SMTP_PORT`/`SMTP_SECURE` pair (587 + `false`, or 465 + `true`) |
| `ADMOB_AD_UNIT_IDS` | your rewarded ad unit ID (required) |
| `ADMIN_BASE_URL` | `https://slimshot-admin.techfamz.com` |
| `JWT_ACCESS_TTL_SECONDS`, `JWT_REFRESH_TTL_SECONDS` | keep **one** of each if they appear twice |

Don't run `init-env.sh` after copying: it never overwrites an existing `.env`.

### Either way

- **A value containing `$`** must be wrapped in single quotes, e.g. `SMTP_PASSWORD='pa$word'`.
- **Copy the whole finished `.env` into your password manager now.** Two values must never be lost or changed:
  - `MASTER_ENCRYPTION_KEY` unlocks the provider keys saved in the database;
  - `IDENTITY_HMAC_SECRET` keeps the signup-bonus history valid.

## 5. HTTPS with a free certificate

```bash
./deploy/scripts/setup-nginx.sh slimshot-server.techfamz.com you@techfamz.com
```

It checks that the domain points at this VPS, gets a Let's Encrypt certificate, installs the
nginx site from `deploy/nginx/`, and tests automatic renewal. The certificate renews by
itself every two to three months, with no action from you.

Until the first deploy, the site answers **502**. That's expected.

## 6. First deploy

```bash
./deploy/scripts/deploy.sh
```

The first build takes 3–5 minutes. The script:
1. pulls the code;
2. builds the image;
3. starts Postgres and Redis;
4. applies the migrations and seeds the default storage row;
5. starts the API and waits for its health check.

Check it from anywhere (**PC** or the VPS):

```bash
curl https://slimshot-server.techfamz.com/health
# {"status":"ok"}
curl https://slimshot-server.techfamz.com/health/ready
# {"status":"ok","checks":{"database":"up","redis":"up"}}
```

## 7. Connect everything to the live API

1. **Dashboard.** Host it on this VPS at `https://slimshot-admin.techfamz.com` by following
   the **slimshot-admin** repo's `docs/deploy/vps-setup.md` (about 15 minutes). Then:
   - Sign in with the bootstrap owner, then delete the two `ADMIN_BOOTSTRAP_*` lines from
     the server's `.env` and run `SKIP_PULL=1 ./deploy/scripts/deploy.sh`.
   - If the browser shows a CORS error, `ADMIN_BASE_URL` doesn't match the address the
     dashboard runs on.
2. **In the dashboard:**
   - **Settings → Providers:** add the Deepgram or ElevenLabs key.
   - **Settings → Pricing:** create and activate a caption price. Auto caption answers
     "unavailable" until you do.
   - **Settings → Credits:** review the amounts.
3. **Mobile app:** API base `https://slimshot-server.techfamz.com/api/app/v1`.
4. **AdMob:** on the rewarded ad unit, set the server-side verification callback to
   `https://slimshot-server.techfamz.com/api/app/v1/rewards/admob/ssv` and press **Verify URL**.
5. **Google Play Console → Data safety → account deletion URL:**
   `https://slimshot-server.techfamz.com/account-deletion`.

## 8. Backups to Google Drive

A dump runs every night at 03:15 UTC (as root):
- kept on the VPS for **14 days**;
- copied to Google Drive and kept there for **30 days**.

Drive needs a one-time link, done partly on your PC because the VPS has no browser.

**On the VPS:**

```bash
rclone config
```

Answer the questions in this order:
1. `n` (new remote), name it **`gdrive`**.
2. Storage: **`drive`** (Google Drive).
3. `client_id` and `client_secret`: leave both empty.
4. Scope: **`drive.file`**, so rclone sees only the files it creates.
5. `root_folder_id` and `service_account_file`: leave empty.
6. Edit advanced config: `n`.
7. Use auto config / web browser: **`n`**. It then prints a command such as
   `rclone authorize "drive" "…"`.

**PC:** install rclone, then run that exact command:

```powershell
winget install Rclone.Rclone
rclone authorize "drive" "…the text the VPS printed…"
```

Your browser opens. Sign in to the Google account that should hold the backups and allow
access. PowerShell then prints a token: copy all of it, paste it into the waiting VPS prompt,
and answer `n` to "Configure this as a Shared Drive". Confirm with `y`, then quit with `q`.

Test it:

```bash
./deploy/scripts/backup-db.sh
# … saved /var/backups/slimshot/slimshot-…dump
# … copied to gdrive:slimshot-backups
```

A `slimshot-backups` folder now appears in that Google Drive. Nightly results go to
`/var/log/slimshot-backup.log`.

Before risky changes, such as a big migration or an Ubuntu release upgrade, also take a
**snapshot** in Contabo's control panel.

### Restoring

```bash
ls -lh /var/backups/slimshot/                                  # local dumps
rclone ls gdrive:slimshot-backups                               # Drive dumps
rclone copy gdrive:slimshot-backups/slimshot-YYYYMMDD-HHMMSS.dump /tmp/   # fetch one from Drive

./deploy/scripts/restore-db.sh /tmp/slimshot-YYYYMMDD-HHMMSS.dump
```

The restore script:
- asks you to type `RESTORE`;
- backs up the current database first;
- stops the API, restores the dump, then starts the API again.

## 9. Automatic deploys on push (webhook)

Once the first manual deploy works, a push to `main` can deploy by itself:

1. GitHub calls `https://slimshot-server.techfamz.com/hooks/deploy`.
2. A small listener on the VPS checks GitHub's signature.
3. It runs `deploy.sh`: pull, build, migrate, restart, health check.

Pushes to any other branch are ignored. No GitHub token is needed: the listener and GitHub
share one secret, and pulls still use the read-only deploy key from step 2.

**On the VPS:**

```bash
./deploy/scripts/setup-webhook.sh
```

It:
- installs the listener (Ubuntu's `webhook` package);
- runs it as an unprivileged `slimshot-hook` user, the one piece that answers the internet;
- adds one `sudo` rule so that user can run exactly one thing as root: this app's deploy script;
- creates the secret in `/etc/slimshot/webhook.env`;
- starts the `slimshot-webhook` service, which listens only on `127.0.0.1:9000` behind nginx;
- prints what to paste into GitHub.

**On GitHub:** open the repository's **Settings → Webhooks → Add webhook**:

| Field | Value |
|---|---|
| Payload URL | `https://slimshot-server.techfamz.com/hooks/deploy` |
| Content type | `application/json` |
| Secret | the one the script printed (`cat /etc/slimshot/webhook.env` shows it again) |
| SSL verification | Enable |
| Which events | Just the push event |

GitHub sends a **ping** straight away. Check it arrived:

```bash
tail -n 5 /var/log/slimshot-deploy.log
# … GitHub ping received: the webhook is connected.
```

From then on, after you push to `main`, watch the deploy with
`tail -f /var/log/slimshot-deploy.log`.

> **GitHub only sees "delivered".** It shows the request reached the server, not whether the
> deploy worked, because the deploy runs after GitHub has had its answer. The result, including
> any failure, is in `/var/log/slimshot-deploy.log`. A push that breaks the build or fails the
> health check leaves the API down until you push a fix, so run `npm test` before pushing to
> `main`.

Two deploys never overlap: a webhook deploy and a manual `deploy.sh` wait for each other.

**To pause automatic deploys:** `systemctl stop slimshot-webhook`.
**To resume them:** `systemctl start slimshot-webhook`.

## 10. Everyday use

| To | Run (as root, in `/var/www/slimshot_server`) |
|---|---|
| Deploy new code (push from your PC first; automatic once step 9 is set up) | `./deploy/scripts/deploy.sh` |
| Watch automatic deploys | `tail -f /var/log/slimshot-deploy.log` |
| Apply a `.env` change | `SKIP_PULL=1 ./deploy/scripts/deploy.sh` |
| Follow the API's log | `docker compose -f docker-compose.prod.yml logs -f api` |
| See what's running | `docker compose -f docker-compose.prod.yml ps` |
| Restart the API only | `docker compose -f docker-compose.prod.yml restart api` |
| Open the database | `docker compose -f docker-compose.prod.yml exec postgres psql -U slimshot` |
| nginx logs | `tail -f /var/log/nginx/slimshot-api.error.log` |
| Disk and memory | `df -h`, `free -h`, `docker system df` |
| Reinstall nginx config after editing `deploy/nginx/*` | `./deploy/scripts/setup-nginx.sh slimshot-server.techfamz.com you@techfamz.com` |

Tip: `echo "alias dc='docker compose -f /var/www/slimshot_server/docker-compose.prod.yml'" >> ~/.bashrc`
then log in again, and `dc logs -f api` works.

Security updates install themselves. After a kernel update, `reboot` when convenient:
Docker and every container come back on their own.

## 11. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `deploy.sh`: "Fill in the values listed above" | `.env` still has `CHANGE_ME`; edit it |
| `deploy.sh`: "The API did not become healthy" | Read the log lines it printed. "Invalid environment configuration" lists exactly which `.env` value is wrong |
| Browser shows **502 Bad Gateway** | The API isn't running: `dc ps`, then `dc logs --tail=100 api` |
| App upload fails with **413** | The file is over 60 MB (nginx limit; captions allow 50 MB) |
| `setup-nginx.sh`: "does not resolve" / "points to …" | The A record is missing or wrong, or hasn't spread yet; wait and re-run |
| certbot fails | Port 80 must reach the VPS (`ufw status` shows `Nginx Full`), and DNS must point here |
| Dashboard shows a CORS error | `ADMIN_BASE_URL` must equal the dashboard's address exactly (scheme, host and port) |
| Sign-in emails don't arrive | `dc logs api` shows the SMTP error; check host, port and `SMTP_SECURE` together |
| Locked out of SSH | Contabo control panel → VNC console, log in as root with the root password |
| `git clone`: `Permission denied (publickey)` | The clone didn't use the deploy key: run the step 2 `export GIT_SSH_COMMAND=…` line (with `export`), then the clone. If `ssh -i /root/.ssh/github_slimshot -T git@github.com` also fails, add the `.pub` key to the repo's **Deploy keys** |
| `git pull`: `detected dubious ownership` | The folder isn't owned by root: `chown -R root:root /var/www/slimshot_server` (or re-run `setup-vps.sh`) |
| `git pull`: `Permission denied (publickey)` | Re-run `setup-vps.sh`: it adds the `github-slimshot` alias and points the repo at it |
| GitHub webhook delivery shows **403** | No signature reached the listener: the GitHub secret field is empty, or the content type isn't `application/json` |
| GitHub webhook delivery shows **500** | The signature didn't match: the secret in GitHub differs from `/etc/slimshot/webhook.env`. Paste it again |
| GitHub webhook delivery shows **502** | The listener isn't running: `systemctl status slimshot-webhook`, then `journalctl -u slimshot-webhook -n 50` |
| Webhook says delivered but nothing deployed | `tail -n 50 /var/log/slimshot-deploy.log`. It says why: another branch, a failed build, or a health check. If it's empty, check `journalctl -u slimshot-webhook -n 50` for a `sudo` error |

## 12. Security notes

- **Only ports 22, 80 and 443 are open.**
  - The API listens on `127.0.0.1:2700`, reachable only through nginx.
  - Postgres and Redis publish no ports at all. Docker's published ports bypass the UFW
    firewall, so never add a `ports:` line to them in `docker-compose.prod.yml`.
- **SSH:** key-only, so no password can be guessed. Root logs in with a key
  (`PermitRootLogin prohibit-password`), and fail2ban bans repeated failures.
- **`.env`:** readable only by root and never committed (it's in `.gitignore`); keep a copy in
  your password manager.
- **Redis:** requires a password, and nothing outside the private Docker network can reach it.
- **The deploy webhook** (`/hooks/deploy`):
  - It runs nothing unless the request carries GitHub's signature, made with the secret in
    `/etc/slimshot/webhook.env` (root-only).
  - The listener runs as the unprivileged `slimshot-hook` user. Its only power is one `sudo`
    rule (`/etc/sudoers.d/slimshot-webhook`) to run `webhook-deploy.sh`, which only deploys
    `main` from GitHub and takes no commands from the request.
  - If the secret ever leaks, replace it: delete that file, re-run `setup-webhook.sh`, and paste
    the new secret into GitHub.

**Check it yourself** after the first deploy:

```bash
ufw status verbose            # only 22, 80 and 443 allowed
fail2ban-client status sshd   # the SSH jail and any banned addresses
ss -tlnp                      # 22, 80, 443 public; 2700 and 9000 on 127.0.0.1 only; no 5432 or 6379
```

From the **PC**, both of these must fail, which proves the database and Redis are not
exposed:

```powershell
Test-NetConnection VPS_IP -Port 5432
Test-NetConnection VPS_IP -Port 6379
```

## Hosting other apps on this VPS

The server-wide setup (firewall, key-only SSH, fail2ban, Docker, nginx, swap, automatic
updates) serves every app. For each new app:

- **Its own folder,** e.g. `/var/www/other-app`, cloned with its **own** deploy key. GitHub
  allows one repo per deploy key, so give each repo its own alias in `/root/.ssh/config`, the
  way this one uses `github-slimshot`:
  ```
  Host github-otherapp
    HostName github.com
    User git
    IdentityFile ~/.ssh/github_otherapp
    IdentitiesOnly yes
  ```
  and clone with `git clone git@github-otherapp:owner/other-app.git`.
- **Its own nginx site** in `/etc/nginx/sites-available/` for its own domain, plus its own
  certificate (`certbot certonly --webroot -w /var/www/certbot -d its.domain`). Don't edit
  `slimshot-api`; this repo's `setup-nginx.sh` rewrites it.
- **Different ports.** SlimShot uses `127.0.0.1:2700` (API) and `127.0.0.1:9000` (webhook);
  give other apps other ports, also bound to `127.0.0.1` only.
- **Its own Compose project name** (`name:` in its compose file) so containers, volumes and
  networks don't mix with `slimshot_*`.
- **Memory:** SlimShot's Postgres is tuned for about 1.5 GB and Redis is capped at 512 MB.
  If other apps bring their own databases, lower `shared_buffers` and `effective_cache_size`
  in `docker-compose.prod.yml`, or share one Postgres between apps.
- **Webhooks:** each app can have its own listener service on its own port and `/hooks/`
  path, or you can add more hooks to one listener.

## Where things live

| Path | What it is |
|---|---|
| `Dockerfile` | The API image: Node 24 on Debian slim, built in stages; the app runs as a non-root user inside the container |
| `docker-compose.prod.yml` | The API, Postgres, Redis, and the one-off `migrate` step |
| `.env.production.example` | Template for the server's `.env` |
| `deploy/scripts/setup-vps.sh` | First-time server setup (run once; safe to re-run) |
| `deploy/scripts/init-env.sh` | Creates `.env` with fresh secrets (run once) |
| `deploy/scripts/setup-nginx.sh` | nginx and the Let's Encrypt certificate |
| `deploy/scripts/deploy.sh` | Pull, build, migrate, restart, health check |
| `deploy/scripts/backup-db.sh` / `restore-db.sh` | Nightly backup and restore |
| `deploy/scripts/setup-webhook.sh` | Turns on automatic deploys (run once) |
| `deploy/scripts/webhook-deploy.sh` | What the webhook runs: deploys pushes to `main`, logs everything |
| `deploy/nginx/` | The nginx site, the proxy settings and the certificate-request config |
| `deploy/webhook/` | The listener's rule (`hooks.json`) and its systemd service |

On the VPS:

| Path | What it is |
|---|---|
| `/var/www/slimshot_server` | The code and `.env` |
| Docker volumes `slimshot_pgdata`, `slimshot_redisdata` | The database and Redis data (survive restarts and deploys) |
| `/root/.ssh/github_slimshot`, `/root/.ssh/config` | The repo's deploy key and its `github-slimshot` alias |
| `/var/backups/slimshot` | Local database dumps (14 days) |
| `/var/log/slimshot-backup.log` | Nightly backup results |
| `/var/log/slimshot-deploy.log` | Every automatic deploy's output |
| `/etc/slimshot/webhook.env` | The webhook secret |
| `/etc/sudoers.d/slimshot-webhook` | The webhook user's one `sudo` rule |
| `/etc/nginx/sites-available/slimshot-api` | The installed nginx site |
