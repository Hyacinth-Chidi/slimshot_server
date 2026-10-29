# SlimShot admin API: database backups

The routes behind the dashboard's **System › Backups** page: automatic backups on or off and
how often, a backup on demand, and the list of backups with download, restore command and
delete. Backups are `pg_dump` archives in the private R2 bucket named by `R2_BACKUP_BUCKET`;
setting it up is in `docs/deploy/vps-setup.md`, "Backups to R2".

## Basics

- **Base URL:** `https://<server>/api/admin/v1`.
- **Auth:** the dashboard's admin access token, `Authorization: Bearer <token>`.
- **Envelope:** `{ "success": true, "data": … }` or
  `{ "success": false, "error": { "code", "message", "details"?, "traceId" } }`. Branch on `code`.
- **Permission:** every route needs `backups.manage`, which only the **owner** has.
- **Audited:** every backup made or failed, download link, restore command, delete and
  settings change (actions `backup.created`, `backup.failed`, `backup.downloaded`,
  `backup.restore_command`, `backup.deleted`, `backup.settings.updated`; entity `Backup`,
  named by its file, or `BackupSettings`). Signed links are never recorded.
- Dates are ISO 8601 strings in UTC.

### When backups are not set up

Backups run only on the live server (`NODE_ENV=production`) with `R2_BACKUP_BUCKET` set.
Anywhere else, `GET /backups` still answers (with `configured: false` and the reason), and
every other route answers **503** `BACKUPS_NOT_CONFIGURED`, "Backups are not set up on this
server." `PUT /backups/settings` is the exception: it saves.

### Backup names

`slimshot-YYYYMMDD-HHMMSS-<auto|manual>.dump`, the UTC time the backup started and what
started it: the daily check (`auto`) or the owner (`manual`). A `:filename` in a path must be
exactly such a name; anything else is **404**, and objects in the bucket that aren't named this
way are never listed or reachable.

### Errors common to every route

| Status | `code` | When |
|---|---|---|
| 401 | `UNAUTHENTICATED` | Missing, expired or invalid admin token. Refresh once, then sign in. |
| 403 | `FORBIDDEN` | Not the owner. |
| 503 | `BACKUPS_NOT_CONFIGURED` | See above. |

## `GET /backups`

Everything the page shows. The list is read from the bucket every time, newest first.

```json
{
  "success": true,
  "data": {
    "configured": true,
    "notConfiguredReason": null,
    "settings": { "autoEnabled": true, "intervalDays": 1 },
    "status": {
      "running": false,
      "lastRunAt": "2026-10-29T03:15:00.000Z",
      "lastRunOk": true,
      "lastRunError": null,
      "lastRunTrigger": "auto",
      "nextAutoAt": "2026-10-30T03:15:00.000Z"
    },
    "backups": [
      {
        "filename": "slimshot-20261029-031500-auto.dump",
        "sizeBytes": 18734211,
        "createdAt": "2026-10-29T03:15:00.000Z",
        "trigger": "auto"
      },
      {
        "filename": "slimshot-20261028-142210-manual.dump",
        "sizeBytes": 18702944,
        "createdAt": "2026-10-28T14:22:10.000Z",
        "trigger": "manual"
      }
    ]
  }
}
```

- `running`: a backup is queued or in progress. Poll every few seconds while it is true.
- `lastRun*`: the last attempt, automatic or manual. `lastRunOk: false` comes with
  `lastRunError`, e.g. `"pg_dump: error: connection to server … failed"`; the database
  password never appears in it.
- `nextAutoAt`: when the next automatic backup will run: the first daily check (03:15 UTC) at
  which the newest automatic backup is at least `intervalDays` old, less an hour of slack. `null`
  when automatic backups are off. Manual backups don't move it.

Not set up:

```json
{
  "success": true,
  "data": {
    "configured": false,
    "notConfiguredReason": "no-bucket",
    "settings": { "autoEnabled": true, "intervalDays": 1 },
    "status": {
      "running": false,
      "lastRunAt": null,
      "lastRunOk": null,
      "lastRunError": null,
      "lastRunTrigger": null,
      "nextAutoAt": null
    },
    "backups": []
  }
}
```

`notConfiguredReason` is `"no-bucket"` (the live server without `R2_BACKUP_BUCKET`) or
`"not-production"` (any other server).

## `PUT /backups/settings`

Body, either field or both:

```json
{ "autoEnabled": true, "intervalDays": 7 }
```

`intervalDays` is `1`, `7` or `30`; anything else is **422** `VALIDATION_FAILED`, as is any
other field. Answers the saved settings:

```json
{ "success": true, "data": { "autoEnabled": true, "intervalDays": 7 } }
```

## `POST /backups`

Starts a backup now. No body. **202**:

```json
{ "success": true, "data": { "started": true } }
```

The backup runs in the background (a minute or two); `GET /backups` shows `running: true` until
it ends, then the new backup or `lastRunOk: false`.

| Status | `code` | When |
|---|---|---|
| 409 | `CONFLICT` | "A backup is already running." |

## `GET /backups/:filename/download`

A link that downloads the backup under its own name, valid for **5 minutes**:

```json
{
  "success": true,
  "data": {
    "url": "https://<account>.r2.cloudflarestorage.com/slimshot-backups/postgres/slimshot-20261029-031500-auto.dump?X-Amz-…",
    "expiresAt": "2026-10-29T10:05:00.000Z"
  }
}
```

Open it straight away (`window.location.assign(url)`); fetch a new one for each download.

| Status | `code` | When |
|---|---|---|
| 404 | `NOT_FOUND` | Not a backup name, or no such backup in the bucket. |

## `GET /backups/:filename/restore-command`

The command that restores this backup on the VPS, with a link valid for **1 hour**:

```json
{
  "success": true,
  "data": {
    "command": "./deploy/scripts/restore-db.sh 'https://<account>.r2.cloudflarestorage.com/slimshot-backups/postgres/slimshot-20261029-031500-auto.dump?X-Amz-…'",
    "expiresAt": "2026-10-29T11:00:00.000Z"
  }
}
```

It runs in the server's folder on the VPS. Putting `--check` after `restore-db.sh` rehearses the
restore without touching the live database.

| Status | `code` | When |
|---|---|---|
| 404 | `NOT_FOUND` | Not a backup name, or no such backup in the bucket. |

## `DELETE /backups/:filename`

Deletes one backup. **204**, no body.

| Status | `code` | When |
|---|---|---|
| 404 | `NOT_FOUND` | Not a backup name, or no such backup in the bucket. |
| 409 | `CONFLICT` | "The newest backup can't be deleted.", so there is always one left. |
