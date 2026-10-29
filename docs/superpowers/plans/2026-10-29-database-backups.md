# Database backups to R2 (server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The API backs the Postgres database up to the private R2 bucket `slimshot-backups` on a schedule set from the dashboard and on demand, lists, links, deletes those backups, and the VPS scripts restore one safely.

**Architecture:** A `backups` module: pure rules (names, due dates), a `pg_dump` runner, an R2 store for the backup bucket, a service that orchestrates, a BullMQ worker (concurrency 1) and a daily job scheduler (03:15 UTC). Owner-only admin routes in a new controller. The bucket is the record of which backups exist; one `BackupSettings` row holds the schedule and the last run's outcome. Deploy scripts retire the old cron job and restore by building the restored database beside the live one.

**Tech Stack:** NestJS 11, Prisma 7, BullMQ 5 (`@nestjs/bullmq`), `@aws-sdk/client-s3` + `s3-request-presigner`, Postgres 17 `pg_dump`, Jest 30, bash.

**Spec:** `docs/superpowers/specs/2026-10-29-database-backups-design.md`

## Global Constraints

- **Context7 before framework code**: BullMQ job schedulers and deduplication, Prisma 7 migrate diff, AWS SDK v3 presigning.
- Backups run only when `NODE_ENV=production` **and** `R2_BACKUP_BUCKET` is set. Otherwise every route answers "not configured", and nothing touches R2 or runs `pg_dump`.
- `R2_BACKUP_BUCKET` must not equal `R2_BUCKET`: the server refuses to start.
- The database password never appears in `pg_dump`'s arguments, in logs, in `lastRunError` or in an audit entry.
- Object names: `postgres/slimshot-YYYYMMDD-HHMMSS-<auto|manual>.dump` (UTC). Routes accept only names matching `^slimshot-\d{8}-\d{6}-(auto|manual)\.dump$`; anything else is 404.
- Upload only after `pg_dump` exits 0 and its file is non-empty. Temp files live in `<os tmp>/slimshot-backups` (dir `0700`, files `0600`) and are always removed.
- Interval values are exactly 1, 7, 30. Defaults: on, every 1 day. Daily check at 03:15 UTC; due when `now ≥ newest automatic + intervalDays × 24 h − 1 h`. A manual backup doesn't move the cadence.
- Download links last 300 s; restore-command links last 3600 s. A run stops after 30 min.
- New permission `backups.manage`: owner only. Audit actions: `backup.created`, `backup.failed`, `backup.deleted`, `backup.downloaded`, `backup.restore_command`, `backup.settings.updated`.
- The Docker image must keep building on the VPS; it can't be built on this PC (no Docker), so the Dockerfile change is checked by test and by reading.
- **Commit `src/generated/prisma` changes**: the Docker build compiles the committed client and doesn't run `prisma generate`. Commit only files whose content changed, not line-ending noise.
- Commits: conventional, plain English, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Branch `feat/db-backups`.

## Review Focus

1. **The dev PC with `R2_BACKUP_BUCKET` set** (`NODE_ENV` unset, i.e. development): no listing, no upload, no delete, no scheduler. → Task 5 test "is not configured outside production".
2. **A `DATABASE_URL` with Prisma-only query parameters or a percent-encoded password** (`p%40ss`, `?schema=public&connection_limit=5`): `pg_dump` gets a decoded password in `PGPASSWORD` and none of Prisma's parameters. → Task 3 tests.
3. **`pg_dump` writing to stderr with the password in it** (libpq echoes connection strings in some errors): `lastRunError` and the audit entry have it scrubbed. → Task 5 test "never stores the password in a failure".
4. **A stray object in the bucket** (`postgres/notes.txt`, `postgres/slimshot-20261029.dump`): never listed, never deletable, never a candidate for "newest". → Task 4 test.
5. **Two clicks of Back up now in a row**: the second answers 409 while the first is queued or running. → Task 5 test "refuses a second backup while one is queued or running".

---

### Task 1: Configuration

**Files:**
- Modify: `src/config/env.validation.ts`, `src/config/env.validation.spec.ts`, `src/config/index.ts`, `src/app.module.ts` (load the new config), `.env.example`, `.env.production.example`
- Create: `src/config/backup.config.ts`

**Interfaces:**
- Produces: `Env.R2_BACKUP_BUCKET?: string` (blank → undefined); cross-field problem when it equals `R2_BUCKET`; `backupConfig` (`registerAs('backup')`) → `{ bucket: string | null; production: boolean }`; `type BackupConfig`.

- [ ] **Step 1: Write the failing tests** (`env.validation.spec.ts`)

```ts
it('leaves backups off when R2_BACKUP_BUCKET is blank', () => {
  expect(parseEnv({ ...BASE, R2_BACKUP_BUCKET: '' }).R2_BACKUP_BUCKET).toBeUndefined();
});
it('refuses a backup bucket that is the public bucket', () => {
  expect(() => parseEnv({ ...BASE, R2_BACKUP_BUCKET: BASE.R2_BUCKET })).toThrow(
    'R2_BACKUP_BUCKET must not be R2_BUCKET: backups would be public',
  );
});
it('exposes backup settings', () => {
  process.env = { ...BASE, R2_BACKUP_BUCKET: ' slimshot-backups ', NODE_ENV: 'production' };
  expect(backupConfig()).toEqual({ bucket: 'slimshot-backups', production: true });
});
```

- [ ] **Step 2: Run** `npx jest src/config`. Expected: FAIL.
- [ ] **Step 3: Implement** the optional field (`@Transform(text) @IsOptional() @IsString()`), the check in `crossFieldProblems`, `backupConfig`, its export and its registration. Add documented lines to both env examples: `R2_BACKUP_BUCKET=` with a comment ("private bucket for database backups; empty = off; never the public bucket").
- [ ] **Step 4: Run** `npx jest src/config && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(backups): the backup bucket setting, never the public bucket`

---

### Task 2: `BackupSettings` table

**Files:**
- Modify: `prisma/schema.prisma`, the changed files under `src/generated/prisma`
- Create: `prisma/migrations/20261029130000_backup_settings/migration.sql`, `src/prisma/backup-settings-schema.spec.ts`

**Interfaces:**
- Produces: model `BackupSettings { id String @id; autoEnabled Boolean @default(true); intervalDays Int @default(1); lastRunAt DateTime?; lastRunOk Boolean?; lastRunError String?; lastRunTrigger String?; updatedById String?; updatedAt DateTime @updatedAt }`. The migration also adds `CHECK ("intervalDays" IN (1, 7, 30))` and inserts the row `('default', true, 1, CURRENT_TIMESTAMP)`.

- [ ] **Step 1: Write the failing test**: read the migration SQL and assert it contains `CREATE TABLE "BackupSettings"`, the CHECK, and an `INSERT INTO "BackupSettings"` with `'default', true, 1`.
- [ ] **Step 2: Run** `npx jest src/prisma/backup-settings-schema.spec.ts`. Expected: FAIL (no file).
- [ ] **Step 3: Implement**: add the model, write the migration (generate the `CREATE TABLE` with `prisma migrate diff`, then add the CHECK and INSERT by hand, as the credits migration does), run `npx prisma generate`, and stage only generated files whose content changed.
- [ ] **Step 4: Run** `npx jest src/prisma && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(backups): a settings row for automatic backups (on, every day)`

---

### Task 3: Rules and the `pg_dump` runner

**Files:**
- Create: `src/modules/backups/backup-rules.ts`, `src/modules/backups/backup-rules.spec.ts`, `src/modules/backups/pg-dump.ts`, `src/modules/backups/pg-dump.spec.ts`

**Interfaces:**
- Produces (`backup-rules.ts`):
  - `type BackupTrigger = 'auto' | 'manual'`
  - `const BACKUP_PREFIX = 'postgres/'`
  - `const BACKUP_INTERVALS = [1, 7, 30] as const`; `type BackupInterval = (typeof BACKUP_INTERVALS)[number]`
  - `interface BackupItem { filename: string; sizeBytes: number; createdAt: Date; trigger: BackupTrigger }`
  - `backupFilename(at: Date, trigger: BackupTrigger): string`
  - `parseBackupFilename(name: string): { createdAt: Date; trigger: BackupTrigger } | null`
  - `isDue(now: Date, s: { autoEnabled: boolean; intervalDays: number }, lastAutoAt: Date | null): boolean`
  - `nextAutoAt(now: Date, s: { autoEnabled: boolean; intervalDays: number }, lastAutoAt: Date | null): Date | null`
- Produces (`pg-dump.ts`):
  - `interface PgDumpInvocation { command: 'pg_dump'; args: string[]; env: Record<string, string> }`
  - `pgDumpInvocation(databaseUrl: string, outFile: string): PgDumpInvocation`
  - `type SpawnFn = (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => ChildProcessLike`, where `ChildProcessLike` has `stderr` (readable), `kill()` and `on('close' | 'error')`.
  - `runPgDump(inv: PgDumpInvocation, opts: { timeoutMs: number; spawn?: SpawnFn; secret?: string }): Promise<void>`

`nextAutoAt`, the one algorithm the signature doesn't fix:

```
if !autoEnabled → null
earliest = lastAutoAt ? lastAutoAt + intervalDays·24h − 1h : now
candidate = the first 03:15:00 UTC strictly after now
while candidate < earliest: candidate += 24h
return candidate
```

- [ ] **Step 1: Write the failing tests**

```ts
expect(backupFilename(new Date('2026-10-29T03:15:07Z'), 'auto')).toBe('slimshot-20261029-031507-auto.dump');
expect(parseBackupFilename('slimshot-20261029-031507-manual.dump')).toEqual({ createdAt: new Date('2026-10-29T03:15:07Z'), trigger: 'manual' });
for (const bad of ['notes.txt', 'slimshot-20261029.dump', 'slimshot-20261029-031507-auto.dump.bak', '../slimshot-20261029-031507-auto.dump', 'slimshot-20261399-031507-auto.dump'])
  expect(parseBackupFilename(bad)).toBeNull();

const on = (d: number) => ({ autoEnabled: true, intervalDays: d });
const last = new Date('2026-10-28T03:15:05Z');
expect(isDue(new Date('2026-10-29T03:15:00Z'), on(1), last)).toBe(true);   // 23h59m55s ≥ 23h
expect(isDue(new Date('2026-11-03T03:15:00Z'), on(7), last)).toBe(false);  // 6 days < 6d23h
expect(isDue(new Date('2026-11-04T03:15:00Z'), on(7), last)).toBe(true);
expect(isDue(new Date('2026-10-29T03:15:00Z'), on(7), null)).toBe(true);   // none yet
expect(isDue(new Date('2026-10-29T03:15:00Z'), { autoEnabled: false, intervalDays: 1 }, null)).toBe(false);
expect(nextAutoAt(new Date('2026-10-29T10:00:00Z'), on(1), new Date('2026-10-29T03:15:04Z'))).toEqual(new Date('2026-10-30T03:15:00Z'));
expect(nextAutoAt(new Date('2026-10-29T10:00:00Z'), on(7), new Date('2026-10-29T03:15:04Z'))).toEqual(new Date('2026-11-05T03:15:00Z'));
expect(nextAutoAt(new Date('2026-10-29T02:00:00Z'), on(30), null)).toEqual(new Date('2026-10-29T03:15:00Z'));
expect(nextAutoAt(new Date('2026-10-29T10:00:00Z'), { autoEnabled: false, intervalDays: 1 }, null)).toBeNull();

// pg_dump
const inv = pgDumpInvocation('postgresql://slimshot:p%40ss@postgres:5432/slimshot?schema=public&connection_limit=5&sslmode=require', '/tmp/x.partial');
expect(inv.args).toEqual(['--format=custom', '--no-owner', '--file', '/tmp/x.partial', '--host', 'postgres', '--port', '5432', '--username', 'slimshot', '--dbname', 'slimshot']);
expect(inv.env).toEqual({ PGPASSWORD: 'p@ss', PGSSLMODE: 'require' });
expect(inv.args.join(' ')).not.toContain('p@ss');
expect(pgDumpInvocation('postgresql://u:pw@db/app', '/f').args).toContain('5432');   // default port
// runPgDump with a fake spawn
it('resolves when pg_dump exits 0');
it('rejects with stderr, the password scrubbed, when it exits non-zero');  // 'FATAL: password authentication failed … pw' → message has '[redacted]'
it('rejects "pg_dump is not installed on this server" on ENOENT');
it('kills pg_dump and rejects "The backup took longer than 30 minutes" on timeout'); // jest fake timers, timeoutMs 30·60_000
```

- [ ] **Step 2: Run** `npx jest src/modules/backups`. Expected: FAIL.
- [ ] **Step 3: Implement** both files. Keep libpq parameters `sslmode → PGSSLMODE`, `channel_binding → PGCHANNELBINDING`, `connect_timeout → PGCONNECT_TIMEOUT`, and drop every other query parameter. `runPgDump` spawns with `{ ...process.env, ...inv.env }`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(backups): backup names, when one is due, and pg_dump without the password on the command line`

---

### Task 4: The backup store (R2)

**Files:**
- Modify: `src/core/storage/adapters/r2.adapter.ts` (export the client builder)
- Create: `src/modules/backups/backup-store.ts`, `src/modules/backups/backup-store.spec.ts`

**Interfaces:**
- Consumes: `BACKUP_PREFIX`, `parseBackupFilename`, `BackupItem` (Task 3).
- Produces:
  - `export function buildR2Client(config: Pick<R2Config, 'accountId' | 'accessKeyId' | 'secretAccessKey'>, opts?: { requestTimeoutMs?: number }): S3Client` (the adapter keeps its 30 s default).
  - `class BackupStore { constructor(creds, bucket: string, client?: CommandSender); upload(filePath: string, filename: string, metadata: Record<string, string>): Promise<{ sizeBytes: number }>; list(): Promise<BackupItem[]>; presignGet(filename: string, expiresInSeconds: number): Promise<{ url: string; expiresAt: Date }>; delete(filename: string): Promise<void> }`. Its own client uses `requestTimeoutMs: 600_000`.

- [ ] **Step 1: Write the failing tests** (fake `send` capturing commands)

```ts
it('uploads under postgres/ with its size, a binary type and the metadata', ...)
  // PutObjectCommand input: Bucket 'slimshot-backups', Key 'postgres/slimshot-20261029-031507-auto.dump', ContentLength 11, ContentType 'application/octet-stream', Metadata { trigger: 'auto' }
it('lists every page newest first and ignores stray objects', ...)
  // two ListObjectsV2 pages (ContinuationToken), with 'postgres/notes.txt' and 'postgres/slimshot-20261029.dump' → absent; order by createdAt desc; sizeBytes from Size
it('presigns a download that saves under the backup name', ...)
  // GetObjectCommand with ResponseContentDisposition 'attachment; filename="slimshot-…-auto.dump"'; expiresAt = now + 300 s
it('deletes one object by its full key', ...)
```

- [ ] **Step 2: Run** `npx jest src/modules/backups/backup-store.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Upload `Body` is a read stream of the file, with `ContentLength` from `stat`.
- [ ] **Step 4: Run** `npx jest src/modules/backups src/core/storage`. Expected: PASS (the adapter's specs too).
- [ ] **Step 5: Commit** `feat(backups): read and write the private backup bucket`

---

### Task 5: `BackupsService`, worker and daily scheduler

**Files:**
- Create: `src/modules/backups/backups.constants.ts`, `backups.service.ts`, `backups.service.spec.ts`, `backup.worker.ts`, `backup-scheduler.ts`, `backup-scheduler.spec.ts`, `backups.module.ts`
- Modify: `src/core/errors/error-codes.ts` (`BACKUPS_NOT_CONFIGURED`), `src/app.module.ts`

**Interfaces:**
- Consumes: Tasks 1–4; `AuditService`, `PrismaService`, `appConfig`'s `DATABASE_URL` (via `databaseConfig`).
- Produces:
  - `QUEUE_BACKUPS = 'backups'`; job names `JOB_RUN = 'run'`, `JOB_CHECK = 'check'`; scheduler id `'backup-daily-check'`, pattern `'15 3 * * *'`, tz `'UTC'`.
  - `BACKUP_STORE` token → `BackupStore | null` (null unless production and bucket set).
  - `BackupsService`:
    - `availability(): 'ready' | 'no-bucket' | 'not-production'`
    - `overview(now = new Date()): Promise<BackupsOverview>`, where `BackupsOverview = { configured: boolean; notConfiguredReason: 'no-bucket' | 'not-production' | null; settings: { autoEnabled: boolean; intervalDays: BackupInterval }; status: { running: boolean; lastRunAt: Date | null; lastRunOk: boolean | null; lastRunError: string | null; lastRunTrigger: BackupTrigger | null; nextAutoAt: Date | null }; backups: BackupItem[] }`
    - `updateSettings(patch: { autoEnabled?: boolean; intervalDays?: BackupInterval }, adminId: string): Promise<BackupsOverview['settings']>`
    - `requestBackup(admin: { id: string; email: string }): Promise<void>`
    - `runBackup(trigger: BackupTrigger, actor: { id: string; email: string } | null): Promise<BackupItem>`
    - `runScheduledCheck(now = new Date()): Promise<'ran' | 'not-due' | 'off' | 'not-configured'>`
    - `downloadLink(filename: string, adminId: string): Promise<{ url: string; expiresAt: Date }>`
    - `restoreCommand(filename: string, adminId: string): Promise<{ command: string; expiresAt: Date }>`: command `./deploy/scripts/restore-db.sh '<url>'`
    - `deleteBackup(filename: string, adminId: string): Promise<void>`
  - `BackupWorker` (`@Processor(QUEUE_BACKUPS, { concurrency: 1 })`), `BackupScheduler` (on init: when ready, `upsertJobScheduler`, otherwise remove it; also empties `<tmp>/slimshot-backups`. Not awaited, so Redis can't block boot).

Errors: not ready → 503 `BACKUPS_NOT_CONFIGURED` "Backups are not set up on this server."; running → 409 `CONFLICT` "A backup is already running."; newest → 409 `CONFLICT` "The newest backup can't be deleted."; unknown or invalid name → 404 `NOT_FOUND`.

- [ ] **Step 1: Write the failing tests** (fakes: store, `runPgDump` (injectable), prisma `backupSettings`, queue `getJobCounts`/`add`, audit; a real temp dir)

```ts
it('is not configured outside production, and touches nothing')    // availability 'not-production'; overview configured false, reason, backups []; store never called; requestBackup → 503
it('is not configured without a bucket')                            // reason 'no-bucket'
it('backs up: dumps, checks, uploads, records, audits, cleans up')  // upload called with a .partial file's contents; settings lastRunOk true, lastRunTrigger 'manual'; audit 'backup.created' actor admin; temp dir empty afterwards
it('never uploads a failed dump, records why, and cleans up')       // runPgDump rejects → no upload; lastRunOk false; audit 'backup.failed'; temp empty
it('never uploads an empty dump')                                   // file size 0 → lastRunError 'The database dump came out empty.'
it('never stores the password in a failure')                        // rejection message contains the DATABASE_URL password → stored and audited with '[redacted]'
it('refuses a second backup while one is queued or running')        // getJobCounts → { active: 1 } → 409; { waiting: 1 } → 409
it('queues a manual backup with the admin')                         // queue.add('run', { trigger: 'manual', actor: { id, email } })
it('runs the daily check only when due')                            // off → 'off'; newest auto 2 h old & interval 1 → 'not-due'; newest auto 25 h old → 'ran'; a manual newer than the auto doesn't count
it('reports the next automatic backup from the newest automatic one') // overview.status.nextAutoAt
it('refuses to delete the newest backup, deletes others, 404s strangers and audits') // 'backup.deleted'
it('hands out 5-minute download links and 1-hour restore commands, audited')         // expiresIn 300 / 3600; 'backup.downloaded' / 'backup.restore_command'; command === `./deploy/scripts/restore-db.sh '${url}'`
it('saves settings and audits them')                                // 'backup.settings.updated' with before/after
// scheduler spec
it('schedules the daily check at 03:15 UTC when ready, and removes it when not')
```

- [ ] **Step 2: Run** `npx jest src/modules/backups`. Expected: FAIL.
- [ ] **Step 3: Implement.** `runBackup` uses `mkdtemp`-free fixed paths: `<tmp>/slimshot-backups/<filename>.partial` (dir `0700`, file `0600`), and removes it in `finally`. Audit entries use `entityType: 'Backup'`, `entityId: filename`, `actorType: 'admin'` or `'system'`. Settings use `entityType: 'BackupSettings'`, `entityId: 'default'`. `running` = active + waiting jobs > 0.
- [ ] **Step 4: Run** `npx jest src/modules/backups && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(backups): back up on demand and on schedule, one at a time`

---

### Task 6: Owner-only admin routes

**Files:**
- Create: `src/modules/admin/admin-backups.controller.ts`, `src/modules/admin/dto/backup-admin.dto.ts`, `src/modules/admin/admin-backups.http.spec.ts`
- Modify: `src/core/auth/permissions.ts` (`'backups.manage'` in `PERMISSIONS` and `OWNER`), `src/modules/admin/admin.module.ts` (import `BackupsModule`), `src/core/auth/admin-routes.spec.ts` (list the controller), `src/modules/admin/audit-labels.ts` (+ spec: `Backup` entries are labelled with their `entityId`, never deleted)

**Interfaces:**
- Consumes: `BackupsService` (Task 5).
- Produces: routes per spec §6 under `api/admin/v1/backups`. `UpdateBackupSettingsDto { @IsOptional() @IsBoolean() autoEnabled?; @IsOptional() @IsIn([1, 7, 30]) intervalDays? }`. Path `:filename` is checked with `parseBackupFilename` and is 404 when null.

- [ ] **Step 1: Write the failing tests** (HTTP spec, as `admin-user-stats.http.spec.ts`)

```ts
it('lists the overview')                             // GET → 200 { success: true, data: … }
it('saves settings and refuses other intervals')     // PUT { intervalDays: 7 } → 200; { intervalDays: 14 } → 422
it('starts a backup with 202')                       // POST → 202 { started: true }; service called with { id, email } from the token
it('404s a name outside the backup pattern without calling the service') // GET /backups/notes.txt/download → 404
it('answers download and restore-command links')
it('deletes with 204')
it('needs backups.manage, which only the owner has') // metadata on each handler; roleHas('admin','backups.manage') false; roleHas('owner', …) true
```

- [ ] **Step 2: Run** `npx jest src/modules/admin src/core/auth`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(backups): owner-only routes to list, start, download, restore and delete backups`

---

### Task 7: `pg_dump` 17 in the API image

**Files:**
- Modify: `Dockerfile` (runtime stage)
- Create: `src/modules/backups/pg-dump-version.spec.ts`

**Interfaces:** none.

- [ ] **Step 1: Write the failing test**: read `Dockerfile` and `docker-compose.yml`. Assert the runtime stage installs `postgresql-client-(\d+)`, and that this major ≥ the compose `image: postgres:(\d+)` major (17).
- [ ] **Step 2: Run** `npx jest src/modules/backups/pg-dump-version.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**: in the runtime stage, add the PostgreSQL apt repository (key from `https://www.postgresql.org/media/keys/ACCC4CF8.asc`, `deb [signed-by=…] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main`), install `postgresql-client-17`, purge the helper packages, and clear apt lists. Use Context7 or the PostgreSQL wiki for the current repository setup.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `build: pg_dump 17 in the API image, kept in step with the database by a test`

---

### Task 8: VPS scripts

**Files:**
- Modify: `deploy/scripts/deploy.sh`, `deploy/scripts/setup-vps.sh`, `deploy/scripts/backup-db.sh`, `deploy/scripts/restore-db.sh`

**Interfaces:** `restore-db.sh [--check] <file.dump | https://…>`.

- [ ] **Step 1: `deploy.sh`**: after "Checking the API", add the step "Retiring the old nightly backup job". Only when `.env` has a non-empty `R2_BACKUP_BUCKET=` and `/etc/cron.d/slimshot-backup` exists: remove it and `/etc/logrotate.d/slimshot-backup`, then say so. Silent otherwise.
- [ ] **Step 2: `setup-vps.sh`**: stop installing the cron and logrotate files. Keep creating `/var/backups/slimshot` (restore's safety copies). Update its header comment.
- [ ] **Step 3: `backup-db.sh`**: remove the rclone/Google Drive part, and say it is the local safety copy used by `restore-db.sh`.
- [ ] **Step 4: `restore-db.sh`**: rewrite per spec §9 "Restoring":
  - accept a path or an `https://` URL (`curl -fsS --proto =https`, temp file `0600`, removed on exit);
  - `--check` runs steps 3–4 plus counts of `"User"`, `"Asset"` and `"CreditTransaction"`, then drops `slimshot_restore`;
  - a real restore asks RESTORE, takes the safety backup, builds `slimshot_restore`, migrates it with `docker compose --profile tools run --rm -e DATABASE_URL=postgresql://slimshot:<POSTGRES_PASSWORD from .env>@postgres:5432/slimshot_restore migrate`, stops the API, ends connections (`pg_terminate_backend`), renames `slimshot` to `slimshot_before_restore_<UTC ts>` and `slimshot_restore` to `slimshot`, then starts the API;
  - if the API fails its health wait, rename back and start the original;
  - a `trap` starts the API again if the script dies after stopping it;
  - finally, print the `dropdb` line for the old database.
- [ ] **Step 5: Verify**: `bash -n` on all four scripts (exit 0). Run `shellcheck` too if it's available (`shellcheck --version`); if not, say so in the ledger.
- [ ] **Step 6: Commit** `feat(backups): restore beside the live database and swap; retire the nightly cron once R2 backups are set`

---

### Task 9: Documentation and full verification

**Files:**
- Modify: `docs/deploy/vps-setup.md` (§8 becomes "Backups to R2"; the "Where things live" table; troubleshooting rows that mention Drive)
- Create: `docs/admin-backups-api.md` (the §6 routes with JSON examples)

- [ ] **Step 1: Write the docs**:
  - the private bucket rules (no custom domain, no `r2.dev`, no CORS);
  - the `slimshot-server` token covering both buckets;
  - the `.env` line and the redeploy that retires the cron;
  - the Backups page;
  - restoring with `--check` first;
  - dropping `slimshot_before_restore_*`;
  - old local dumps in `/var/backups/slimshot`.
- [ ] **Step 2: Full verification**: `npm run typecheck && npm run lint && npx jest`. Expected: all exit 0; the test count rises by this plan's tests.
- [ ] **Step 3: Commit** `docs: backups to R2`
