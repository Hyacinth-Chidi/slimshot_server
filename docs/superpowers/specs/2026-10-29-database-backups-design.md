# Database backups to R2, managed from the dashboard: design

Date: 2026-10-29. Repos: `slimshot_server` (most of the work, plus `deploy/`), `slimshot-admin`
(System › Backups). Source: a conversation with the owner. Decisions marked *(owner)* are
theirs; *(call)* marks a choice made while writing this, listed again in §13.

## 1. Why

The owner self-hosts the API, Postgres and Redis on one VPS. Today a root cron job
(`/etc/cron.d/slimshot-backup`, installed by `deploy/scripts/setup-vps.sh`) runs
`deploy/scripts/backup-db.sh` nightly at 03:15 UTC and keeps 14 days of dumps in
`/var/backups/slimshot` **on the same VPS**. Its Google Drive copy was never set up. Losing the
VPS loses every backup.

The owner wants off-server copies in Cloudflare R2 and to run backups from the dashboard: switch
automatic backups on or off, choose how often, back up on demand, download and delete.

## 2. Decisions

- **Destination** *(owner)*: a new R2 bucket `slimshot-backups`, **private**: no custom domain,
  no `r2.dev` address, no CORS. It already exists.
- **Credentials** *(owner)*: the existing token `slimshot-server` (Object Read & Write) now
  applies to both `slimshot-audio` and `slimshot-backups`. No new keys; the server reuses
  `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
- **Encryption** *(owner)*: none for now. Leave room to add it later without changing anything
  else (§12).
- **No nightly job on the VPS any more** *(owner)*: schedules are set in the dashboard.
- **Frequency** *(owner)*: automatic backups on/off; every **7** or **30** days, plus **every day**
  (suggested and accepted).
- **Back up now** *(owner)*: a manual backup at any time.
- **Download and Delete** from the dashboard *(owner)*. The newest backup can't be deleted *(call)*.
- **Nothing deletes itself** *(call)*: old backups go only when the owner deletes them.
- **Restore stays a command on the VPS** *(call, owner agreed)*: the page gives a copy-paste
  command; nothing in the dashboard can overwrite the live database.
- **Auto-deploy** *(owner)*: every push to `main` of either repo deploys to the VPS. The feature
  must deploy safely before the VPS has its new `.env` line (§9), and the server deploys first.
- **Production only** *(call)*: backups run only where `NODE_ENV=production`, which
  `docker-compose.yml` sets for the API. The developer PC's `.env` points at the same R2 account
  and buckets as production. Anywhere else, every backup route answers "not configured", so a
  dev server can never add, list, delete or shadow production's backups.

## 3. Goals

1. Off-server copies of the database in `slimshot-backups`, made by the server itself.
2. System › Backups (owner only): automatic on/off and frequency, Back up now, a list of
   backups, Download, Delete, a copy-paste restore command, and the status of the last run.
3. The old VPS cron job retired, without ever leaving the owner with no backups at all.

## 4. Non-goals and anti-goals

**Not now:** encryption; restoring from the dashboard; Google Drive or any second destination;
backing up R2 files (audio, fonts, covers): only the database; automatic deletion or retention
rules; point-in-time recovery; databases over 5 GB (R2's single-upload limit; say so clearly if
it happens).

**Anti-goals (failure even if it "works"):**
- A backup recorded as successful that is empty or cut short. Upload only after `pg_dump` exits 0
  and wrote a non-empty file.
- The database password on a command line (visible to anyone listing processes). Pass it to
  `pg_dump` through its environment, never as an argument.
- A list that hides backups. After a restore the database rolls back, so the list must come from
  the bucket itself, not from database rows.
- Deleting the newest backup, so that nothing is left.
- A backup reachable by anyone but the owner: the bucket stays private, download links are short-
  lived presigned URLs handed only to the owner, and every download is audited.
- `R2_BACKUP_BUCKET` set to the public bucket by mistake. The server refuses to start if it equals
  `R2_BUCKET`.
- Two backups running at once.
- A deploy that breaks the API because the new setting is missing: the API starts, and the page
  explains what to add.
- A gap with no backups: the old cron job is removed only once R2 backups are configured, and
  automatic backups start switched on (§5).
- A restore that leaves the API stopped, or brings back an older table layout under newer code
  (§9, "Restoring").
- Backups silently stopping: the page shows the last run, the next due run, and a failure warning.

## 5. Behaviour

**Automatic backups.** A settings row holds `autoEnabled` and `intervalDays` (1, 7 or 30).
Defaults: **on, every day** *(call: the same protection the nightly job gives today)*. A job runs
every day at **03:15 UTC** *(call)* and makes a backup when automatic backups are on and the
newest *automatic* backup is at least `intervalDays` old, less one hour of slack. If none exists,
it makes one. A failed run is retried the next day; a manual backup doesn't reset the automatic
cadence *(call)*.

**Back up now** starts one immediately. While any backup runs, another request is refused with
409 ("A backup is already running").

**Making a backup:**
1. `pg_dump --format=custom` (the format `restore-db.sh` already restores) into a private temp file
   (`0600`, in a `0700` directory under the system temp dir). Connection details come from
   `DATABASE_URL`; the password goes in `PGPASSWORD` and SSL settings in `PG*` variables. Query
   parameters that are Prisma's, not Postgres's (`schema`, `connection_limit`, …), are dropped.
2. Check the exit code and that the file isn't empty.
3. Upload it to `slimshot-backups` as `postgres/slimshot-YYYYMMDD-HHMMSS-<auto|manual>.dump`
   (UTC), with object metadata `trigger` and, for manual ones, the admin's email.
4. Delete the temp file whatever happened. On boot, delete leftovers from a crash.
5. Record the outcome in the settings row (`lastRunAt`, `lastRunOk`, `lastRunError` with secrets
   scrubbed, `lastRunTrigger`) and audit it: `backup.created` or `backup.failed`, by the admin or
   by the system.

A run that takes over 30 minutes is stopped and recorded as failed *(call)*.

**Listing** reads the bucket under `postgres/`, newest first: filename, size, time and trigger, all
from the object list (no extra request per backup). Objects whose names don't fit the pattern
are ignored. Who started a manual backup is in its object metadata and the audit log, not the list
*(call: only the owner can back up, so it is always them)*.

**Download** gives a presigned GET that lasts 5 minutes *(call)* and makes the browser save the
file under its own name. It is audited as `backup.downloaded`.

**Restore command** gives, for one backup, a presigned GET that lasts 1 hour *(call)* inside a
command: `./deploy/scripts/restore-db.sh '<url>'`, with "run this in the server's folder on the
VPS". It is audited as `backup.restore_command`.

**Delete** removes one object. It refuses the newest backup with 409, and an unknown name with
404. It is audited as `backup.deleted`.

## 6. Server API (admin, owner only)

A new permission, `backups.manage`, given only to the owner. Filenames in paths must match the
backup pattern exactly, so nothing else in the bucket can ever be addressed.

| Route | Answer |
|---|---|
| `GET /api/admin/v1/backups` | `{ configured, notConfiguredReason, settings: { autoEnabled, intervalDays }, status: { running, lastRunAt, lastRunOk, lastRunError, lastRunTrigger, nextAutoAt }, backups: [{ filename, sizeBytes, createdAt, trigger }] }`. Not configured: `configured: false`, `notConfiguredReason` `'no-bucket'` or `'not-production'`, empty `backups`, never an error |
| `PUT /api/admin/v1/backups/settings` | body `{ autoEnabled?, intervalDays? }` (`intervalDays` ∈ 1, 7, 30) → the new settings |
| `POST /api/admin/v1/backups` | 202 `{ started: true }`; 409 when one is running; 503 `BACKUPS_NOT_CONFIGURED` |
| `GET /api/admin/v1/backups/:filename/download` | `{ url, expiresAt }` |
| `GET /api/admin/v1/backups/:filename/restore-command` | `{ command, expiresAt }` |
| `DELETE /api/admin/v1/backups/:filename` | 204; 409 for the newest; 404 unknown |

`nextAutoAt` is the next 03:15 UTC on which a run is due, or null when automatic backups are off.

## 7. Data

- **`BackupSettings`**: a single row with id `default`, inserted by the migration with the §5
  defaults. Columns: `autoEnabled`, `intervalDays`, `lastRunAt?`, `lastRunOk?`, `lastRunError?`,
  `lastRunTrigger?`, `updatedById?`, `updatedAt`. The migration is additive.
- **The bucket is the record of which backups exist.** No table of backups.

## 8. Runtime and image

- The API's Docker image needs **`pg_dump` 17**: the database is `postgres:17`, and `pg_dump`
  refuses to dump a server newer than itself. Debian bookworm's own client is 15, so install
  `postgresql-client-17` from the PostgreSQL apt repository (apt.postgresql.org) in the runtime
  stage.
- A test fails if the client's major version in the `Dockerfile` is below the `postgres:` image
  major in `docker-compose.yml`, so a future Postgres upgrade can't silently break backups.
- Backups run in a BullMQ queue `backups` with concurrency 1, inside the API process. The daily
  check is a BullMQ job scheduler, not cron.
- Without `pg_dump` (e.g. a developer PC), a backup fails with a clear message. Nothing else is
  affected.

## 9. Configuration and deploy

- New `.env` line: **`R2_BACKUP_BUCKET=slimshot-backups`**. It's optional: empty means backups are
  off and the page says what to add. It must not equal `R2_BUCKET`. Documented in `.env.example`,
  `.env.production.example` and the setup guide.
- **`deploy.sh`** gets a step that removes `/etc/cron.d/slimshot-backup` (and its logrotate file)
  **only when `R2_BACKUP_BUCKET` is set** in `.env`, and says it did. It does nothing on later
  deploys.
- **`setup-vps.sh`** no longer installs the nightly cron job.
- **`backup-db.sh`** stays as the one-off local dump that `restore-db.sh` takes before restoring;
  its Google Drive part is removed.
- **`restore-db.sh`** also accepts an `https://` URL: it downloads the dump to a `0600` temp file,
  deleted afterwards. See "Restoring" below for what it then does.
- The setup guide's "Backups to Google Drive" section becomes "Backups to R2": the private bucket,
  the token covering both buckets, the `.env` line, the Backups page, restoring. Old local dumps in
  `/var/backups/slimshot` stay until the owner deletes them.
### Restoring

Migrations land about weekly, so most backups predate the current schema. Today's script runs
`pg_restore --clean` straight into the live database. That only drops what is in the dump: newer
tables survive, `_prisma_migrations` rolls back, and a foreign key from a newer table can abort
the restore halfway with the API stopped. The script instead **builds the restored database
beside the live one and swaps them only when it is complete**:

1. Ask the owner to type RESTORE, as today.
2. Take the safety backup with `backup-db.sh`, as today.
3. Create a fresh database `slimshot_restore`, dropping any leftover one, and `pg_restore
   --no-owner --single-transaction` the backup into it.
4. Run the `migrate` service against `slimshot_restore` (its `DATABASE_URL` overridden):
   `prisma migrate deploy` applies every migration newer than the backup, then the idempotent
   seed.
5. Stop the API. End any remaining connections, then rename `slimshot` to
   `slimshot_before_restore_<UTC timestamp>` and `slimshot_restore` to `slimshot`.
6. Start the API and wait for health, as today.

If step 3 or 4 fails, the live database and the API were never touched: the script drops
`slimshot_restore` and says which step failed. If step 6 fails, the script renames the two
databases back, starts the API on the original, and prints what happened. The previous database
stays as `slimshot_before_restore_<timestamp>` until the owner drops it; the script prints the
one-line command for that. The swap needs room for two copies of the database for a while, which
is small today.

**Rehearsal** *(call)*: `restore-db.sh --check <file|url>` runs steps 3 and 4 only, prints a few
row counts (users, assets, credit transactions), then drops `slimshot_restore`. Nothing live is
touched, and the owner can prove a backup works. The restore-command dialog mentions it.

- **Deploy order:** server first (migration, new routes; feature off until the `.env` line exists),
  then the dashboard. The owner adds `R2_BACKUP_BUCKET` to the VPS `.env` and redeploys, and the
  cron job is retired on that deploy.

## 10. Dashboard: System › Backups (`/system/backups`)

Owner only. Sidebar and phone tabs: AI providers, Sign-in security, **Backups**, Audit log.

- **Header**: title "Backups", subtitle "Copies of the database in your private R2 bucket.",
  primary action **Back up now**. It is disabled while one runs, then reads "Backing up…".
- **Status line** under the header: "Last backup 29 Oct 2026, 03:15 · automatic" and "Next
  automatic backup 30 Oct 2026, 03:15", or "Automatic backups are off". A failed last run shows a
  warning callout with the error.
- **Automatic backups card**: a Switch ("Back up automatically") and a Select (Every day / Every 7
  days / Every 30 days), with its own Save, like the Rewards cards.
- **Backups list**: Date (en-GB date and time), Size, Type ("Automatic" or "Manual"), and
  a `⋯` menu with **Download**, **Copy restore command…** and **Delete…**. For the newest backup,
  Delete is disabled with a tooltip: "The newest backup can't be deleted".
  - **Copy restore command…** opens a dialog: the command in a code block with a Copy button,
    "Valid for 1 hour", and a plain warning that a restore replaces everything written since that
    backup and asks to type RESTORE.
  - **Delete…** confirms by naming the backup's date.
- **While a backup runs**, the page polls every 3 seconds until it finishes, then toasts the result
  and refreshes the list.
- **Not configured**: one card, no other controls. `no-bucket`: explains the `.env` line and the
  redeploy. `not-production`: "Backups run only on the live server."
- Skeletons on first load. shadcn primitives, dark tokens, en-GB dates via `lib/format.ts`.

## 11. Testing

Server (Jest):
- the due rule (on/off, 1/7/30 days, slack, no previous backup, failed runs);
- `pg_dump` arguments and environment built from `DATABASE_URL` (no password in the arguments,
  Prisma parameters dropped);
- the filename pattern;
- a failed or empty dump is never uploaded;
- the temp file is always removed;
- listing and sorting, ignoring stray objects;
- newest-delete refusal;
- one-at-a-time;
- env validation (`R2_BACKUP_BUCKET` ≠ `R2_BUCKET`; optional);
- the Dockerfile ↔ compose major-version check;
- the permission is owner only;
- audits.

Dashboard (Vitest): the page states, polling, menu actions, dialogs, owner-only nav.

Shell scripts (`deploy.sh`, `restore-db.sh`) are checked by reading and with `bash -n` and
`shellcheck` where available. The repo has no shell test harness, and this PC has no Postgres or
Docker. So the first real proof is the owner running `restore-db.sh --check` on the VPS after
deploy; the hand-over lists it as a step.

## 12. Leaving room for encryption

The upload step takes the dump file and returns what it stored. Encryption will become one more
step between dump and upload, behind a future `.env` setting, and restore will gain one matching
step. The object name would change its extension (`.dump.age`, for example) so old and new
backups can live side by side. Nothing in this design needs to change for that.

## 13. Calls made while writing this

1. The newest backup can't be deleted.
2. Nothing deletes itself.
3. Defaults: automatic backups **on, every day**, so the first deploy keeps today's protection.
4. The daily check runs at 03:15 UTC, like today's cron; a manual backup doesn't shift the
   automatic cadence.
5. Download links last 5 minutes; restore-command links last 1 hour.
6. A run is stopped after 30 minutes.
7. The old cron job is removed only once `R2_BACKUP_BUCKET` is set, so there is never a window
   with no backups.
8. `backup-db.sh` stays as the safety copy before a restore; its Google Drive part goes.
9. The list comes from the bucket, not the database, so it is right even after a restore.
10. The server refuses to start if the backup bucket is the public audio bucket.
11. Backups run only in production (`NODE_ENV=production`); a dev server sharing the R2 account
    can't add, list, delete or shadow production's backups.
12. Restore builds the restored database beside the live one, migrates it forward, and swaps
    the two only when it is complete; a failure never leaves the API stopped or the live data
    half-replaced, and the old database is kept until the owner drops it.
13. `restore-db.sh --check` rehearses a restore in the throwaway `slimshot_restore` database
    without touching the live one.
14. The list doesn't show who made a manual backup (it is always the owner); the audit log does.
