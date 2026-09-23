# Admin API Completion — Design (Project A)

**Date:** 2026-09-23
**Status:** Approved for planning
**Repo:** `slimshot_server`
**Follows:** `2026-09-11-slimshot-content-platform-design.md` (Phases 0–3, shipped)

## 1. Purpose

The shipped API covers auth, asset CRUD, ingest and publishing. The admin dashboard
(Project B) additionally needs categories, configuration, observability and aggregate
statistics. This project adds those five surfaces so the dashboard connects to a complete
API on its first day rather than shipping screens that call nothing.

It also closes three findings deferred during Phases 0–3.

## 2. Goals

- A real `Category` table, kind-scoped and hierarchical, replacing the hardcoded list.
- Settings and storage-provider management from the API, with credentials protected by
  step-up re-authentication.
- Read access to the audit log and to queue state.
- Aggregate statistics for a dashboard overview.
- Close deferred findings: `StorageRegistry.invalidate()` having no caller, delayed jobs
  being invisible in queue health, and provider config being seed-only.

## 3. Non-goals

- No collections, tags or licences. Those are a later phase and the dashboard does not
  need them.
- No user-facing endpoints. Identity stays dormant.
- No audit-log deletion at any permission level.
- No changes to the public catalog API — it does not exist yet and is out of scope.

## 4. Constraints and decisions

| Decision | Choice | Consequence |
|---|---|---|
| Category depth | Self-referencing tree, kind-scoped | `Music → Cinematic` expressible; an SFX category can never be offered for fonts |
| Category on Asset | `categoryId String?`, nullable | Existing assets need no migration and no invented default |
| Deleting a used category | Refuse with 409 naming the count | Cascading orphans assets silently; nulling is an unrequested data change |
| Secret visibility | Masked by default, revealed only after re-auth | A stolen session token cannot read a credential |
| Who reaches settings | Owner role only | Matches the existing `settings.write` / `storage.manage` permissions |
| Re-auth transport | Password in the request body over HTTPS | Same model as AWS and GitHub; an elevation-token scheme is more machinery for the same guarantee |
| Failed re-auth | Feeds the existing login lockout counter | Otherwise `/reveal` is an unthrottled password oracle against a known owner account |

## 5. Schema

### 5.1 New model

```prisma
model Category {
  id          String    @id @default(cuid())
  kind        AssetKind
  parentId    String?
  slug        String
  name        String
  description String?
  sortOrder   Int       @default(0)
  isActive    Boolean   @default(true)
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  parent   Category?  @relation("CategoryTree", fields: [parentId], references: [id])
  children Category[] @relation("CategoryTree")
  assets   Asset[]

  @@unique([kind, slug])
  @@index([kind, parentId, sortOrder])
}
```

### 5.2 Change to `Asset`

Add `categoryId String?` plus the relation. Nullable: assets created before categories
existed have no correct default, and requiring one would force a data migration with no
right answer.

### 5.3 Migration

One migration, `add_category`. Additive only — no column is dropped or made non-null, so
existing rows are untouched.

## 6. The settings security model

This is the most security-sensitive part of the project and is specified structurally
rather than by convention.

### 6.1 Reveal is a separate method, not a flag

`SettingsService.getMaskedGroup` masks unconditionally and keeps that behaviour. Reveal is
a new, narrowly-scoped method:

```ts
revealSecret(key: string, actorId: string): Promise<string>
```

It is NOT a boolean parameter on the existing method. A flag can default wrong, be
forwarded from a query string, or be set by a caller that did not intend it. A separate
method cannot be reached by accident.

### 6.2 Exactly one caller

`revealSecret` is reachable from one controller method — `POST /settings/:key/reveal` —
and from nowhere else. A test asserts that: any new caller fails the build.

### 6.3 Three gates, all required

1. `@RequirePermission('settings.write')` — owner role only.
2. `PasswordService.verify` against the calling admin's stored hash. The session token
   alone is insufficient.
3. The admin must not be locked out (shared counter, see 6.5).

### 6.4 Audit before return

An audit row is written BEFORE the value is returned, so a reveal that crashes mid-flight
is still recorded. A failed password attempt writes its own row with the same action
prefix, so repeated failures are visible in the log.

The audit payload records the setting KEY, never its value. `AuditService` already redacts
secret-shaped field names and renders binary as `[binary N bytes]`; this relies on that.

### 6.5 Failed re-auth feeds the login lockout

Failures increment the same `auth:login:fail:<email>` counter used by login, under the same
`auth.loginMaxAttempts` / `auth.loginLockoutSeconds` settings. Without this, `/reveal`
becomes a password oracle that can be brute-forced without ever touching `/auth/login`.

### 6.6 Writes to secret settings are gated identically

`PUT /settings/:key` requires re-auth when the target setting declares `secret: true`.
Non-secret settings update on session auth alone — an upload size cap does not need a
password.

### 6.7 What the response contains

The revealed value and nothing else. `Cache-Control: no-store`. The plaintext is never
logged, never included in an error message, and never written to the audit payload.

## 7. Endpoints

All under `/api/admin/v1`, all guarded by `JwtAuthGuard` + `PermissionsGuard`, all
controllers registered in `ADMIN_CONTROLLERS` so a handler missing its permission
decorator fails the build.

### 7.1 Categories

```
GET    /categories                taxonomy.read   ?kind= → tree with children nested
POST   /categories                taxonomy.write
PATCH  /categories/:id            taxonomy.write
DELETE /categories/:id            taxonomy.write
POST   /categories/reorder        taxonomy.write  body: [{ id, sortOrder }]
```

`DELETE` returns 409 with the referencing asset count when the category is in use.
`POST` and `PATCH` reject a `parentId` whose `kind` differs from the child's.

### 7.2 Stats

```
GET /stats/summary                asset.read
GET /stats/uploads-over-time      asset.read      ?days=30 (1–365)
GET /stats/storage                asset.read
```

`summary` returns totals, counts by status and by kind, total bytes, and the
failed-processing count. That last figure is how a stuck asset becomes visible.

Cached 60 seconds in the existing `CacheService` under a `stats` namespace, invalidated by
the same generation bump publishing already performs.

### 7.3 Audit

```
GET /audit-logs                   audit.read      ?actorId&action&entityType&entityId&cursor&limit
```

Read-only. No delete endpoint exists at any permission level.

### 7.4 Jobs

```
GET  /jobs/health                 jobs.read       waiting / active / failed / delayed
GET  /jobs/failed                 jobs.read       ?cursor
POST /jobs/:id/retry              jobs.read
```

`health` adds `getDelayedCount()`, closing the Task 10 finding: a job between retry
attempts sits in `delayed` and is currently invisible in the admin view.

### 7.5 Settings and storage providers

```
GET   /settings                        settings.read    grouped, secrets masked
PUT   /settings/:key                   settings.write   re-auth if the setting is secret
POST  /settings/:key/reveal            settings.write   re-auth always
GET   /storage-providers               storage.manage   config masked
POST  /storage-providers               storage.manage   re-auth
PATCH /storage-providers/:id           storage.manage   re-auth
POST  /storage-providers/:id/test      storage.manage   verify credentials
POST  /storage-providers/:id/default   storage.manage   re-auth
```

`test` before `default` is deliberate: credentials can be verified before production
uploads are pointed at them, rather than failing on the next upload.

`POST /storage-providers/:id/default` calls `StorageRegistry.invalidate()`. That method has
had no caller since it was written; without this call, changing providers requires a
restart, which defeats admin-managed providers entirely.

## 8. Cross-cutting

- Every mutating handler writes an `AuditLog` row.
- Every list endpoint uses cursor pagination, matching the existing asset list.
- Response envelopes stay `{ success: true, data, meta? }` and the existing typed error
  envelope.
- No new `process.env` reads. No new eslint exemptions.

## 9. Testing

- Unit tests per service against mocked Prisma, following the existing idiom (`as never`,
  never `any`).
- The reveal path gets dedicated tests for each gate independently: wrong password, correct
  password, non-owner role, locked-out account, and that an audit row is written on both
  success and failure.
- A test asserting `revealSecret` has exactly one caller in `src/`.
- A test asserting `DELETE /categories/:id` refuses when assets reference the category.
- The `ADMIN_CONTROLLERS` array gains all five new controllers, so the existing
  build-time check covers them.

## 10. Deferred findings this project closes

- `StorageRegistry.invalidate()` had no caller — now called on provider default change.
- `getQueueHealth()` omitted delayed jobs — now included.
- Provider config was seed-only — now has CRUD.

## 11. Deferred, still

- Cross-instance settings-cache invalidation (Redis pub/sub). Single-replica today; a
  second replica would serve stale config until restart.
- `keyVersion` is recorded but not honoured on decrypt; key rotation needs a code change.
- Readiness probes `storage.getDefault()`, which can hit the database each probe.
- Audit redaction is by field name, not value.
