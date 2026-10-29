# Admin layout redesign — server reads (Phase 0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the read-side fields and one endpoint the redesigned admin dashboard needs: who set a price, when each credit setting last changed and by whom, readable audit entries, per-kind status counts and user counts.

**Architecture:** Every addition is admin-only and additive, with no migrations and no change to `/api/app/v1/*`. Enrichment lives in the admin module: small pure-ish helpers that take `PrismaService` and batch their queries (one query per entity type, never one per row), called from the admin controllers. Domain services (`PricingService`, `CreditSettingsService`) are unchanged.

**Tech Stack:** NestJS 11, Prisma 7 (Postgres), Jest 30 + ts-jest.

**Spec:** `../slimshot-admin/docs/superpowers/specs/2026-10-29-admin-layout-redesign-design.md` §9 (and §7.3, §7.9 for how the fields are used).

## Global Constraints

- Additive only: no Prisma migration, no field removed or renamed, no change under `src/modules/{accounts,captions,catalog,credits,devices,rewards}` behaviour.
- Responses keep the envelope `{ success: true, data, meta? }`.
- Admin identity in responses is always `AdminRef = { id: string; email: string; name: string }` or `null` (unknown or deleted admin).
- No query per row: each helper issues at most one query per entity type it resolves.
- `npm run typecheck`, `npm run lint` (`--max-warnings 0`) and `npm test` stay green after every task.
- Use Context7 for any NestJS/Prisma API you are unsure of.
- Commits: conventional, plain English, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Branch: `feat/admin-layout-reads` from `main`.

## Review Focus

1. **A deleted admin** (soft-deleted `AdminUser`, `deletedAt` set) who set a price or changed a setting: `createdBy`/`by`/`actor` should still show their email (the history happened), not `null`. Only an id with no row at all gives `null`. → Task 1 test.
2. **`disposableEmailDomains` with the same domains in a different order** in an audit `before`/`after`: a reorder is still a change of that field; a byte-identical list is not. → Task 3 test.
3. **Audit entries whose `before` is `null`** (not written for this action) or whose `after` lacks a field: skip that field for that entry rather than counting it as changed. → Task 3 test.
4. **Audit page with 100 rows across six entity types**: exactly one lookup query per type present, none for types absent. → Task 4 test.
5. **Stale summary cache after deploy**: the old `summary` cache entry (60 s TTL) has no `byKindStatus`; the new code must not serve it. → Task 5 test (cache key).

---

### Task 1: `adminsById` — resolve admin ids to `AdminRef`

**Files:**
- Create: `src/modules/admin/admin-directory.ts`
- Test: `src/modules/admin/admin-directory.spec.ts`

**Interfaces:**
- Produces:
  - `export interface AdminRef { id: string; email: string; name: string }`
  - `export async function adminsById(prisma: PrismaService, ids: Array<string | null | undefined>): Promise<Map<string, AdminRef>>`

- [ ] **Step 1: Write the failing tests**

```ts
// admin-directory.spec.ts — prisma fake: { adminUser: { findMany: jest.fn(async ({ where }) => rows.filter(r => where.id.in.includes(r.id))) } }
it('resolves each distinct id once, in one query', async () => {
  const map = await adminsById(prisma as never, ['a1', 'a2', 'a1', null, undefined]);
  expect(prisma.adminUser.findMany).toHaveBeenCalledTimes(1);
  expect(prisma.adminUser.findMany.mock.calls[0][0].where).toEqual({ id: { in: ['a1', 'a2'] } });
  expect(map.get('a1')).toEqual({ id: 'a1', email: 'owner@slimshot.dev', name: 'Owner' });
});
it('still names a soft-deleted admin', async () => {
  // row a2 has deletedAt set; it must be in the map
  expect((await adminsById(prisma as never, ['a2'])).get('a2')?.email).toBe('old@slimshot.dev');
});
it('makes no query when there is nothing to resolve', async () => {
  await adminsById(prisma as never, [null, undefined]);
  expect(prisma.adminUser.findMany).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/modules/admin/admin-directory.spec.ts`
Expected: FAIL, "Cannot find module './admin-directory'".

- [ ] **Step 3: Implement `adminsById`** in `admin-directory.ts`

`findMany({ where: { id: { in: distinctIds } }, select: { id: true, email: true, name: true } })`. No `deletedAt` filter (review focus 1).

- [ ] **Step 4: Run to verify they pass**

Run: `npx jest src/modules/admin/admin-directory.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/admin/admin-directory.ts src/modules/admin/admin-directory.spec.ts
git commit -m "feat(admin): resolve admin ids to their email and name"
```

---

### Task 2: Pricing rules carry `createdBy`

**Files:**
- Modify: `src/modules/admin/admin-pricing-rules.controller.ts`
- Test: `src/modules/admin/admin-pricing-rules.http.spec.ts`

**Interfaces:**
- Consumes: `adminsById`, `AdminRef` (Task 1).
- Produces: every rule in the `GET /pricing-rules`, `POST /pricing-rules` and `POST /pricing-rules/:id/activate` responses has `createdBy: AdminRef | null`.

- [ ] **Step 1: Write the failing tests** in `admin-pricing-rules.http.spec.ts`

Provide `PrismaService` in the testing module as `{ adminUser: { findMany: jest.fn(async () => [{ id: 'admin-1', email: 'o@example.com', name: 'Owner' }]) } }`. Make `pricing.listRules` and `pricing.activate` resolve `[{ id: 'r1', version: 1, createdById: 'admin-1' }, { id: 'r0', version: 0, createdById: 'gone' }]` and `createRule` resolve `{ id: 'r2', version: 2, createdById: 'admin-1' }`.

```ts
it('names who created each rule in the list', async () => {
  const body = await (await fetch(`${base}?feature=auto_captions`)).json();
  expect(body.data[0].createdBy).toEqual({ id: 'admin-1', email: 'o@example.com', name: 'Owner' });
  expect(body.data[1].createdBy).toBeNull();
});
it('names the creator on create and on the list activate returns', async () => {
  // POST create → data.createdBy.email === 'o@example.com'
  // POST r1/activate → data[0].createdBy.email === 'o@example.com'
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/modules/admin/admin-pricing-rules.http.spec.ts`
Expected: FAIL, `createdBy` undefined.

- [ ] **Step 3: Inject `PrismaService` and add `private async withCreators<T extends { createdById: string }>(rules: T[]): Promise<Array<T & { createdBy: AdminRef | null }>>`** to the controller; use it in all three handlers.

- [ ] **Step 4: Run to verify they pass**

Run: `npx jest src/modules/admin/admin-pricing-rules.http.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(admin): pricing rules say who created them"
```

---

### Task 3: Credit settings carry `lastChanged` per field

**Files:**
- Create: `src/modules/admin/credit-settings-history.ts`
- Modify: `src/modules/admin/admin-credit-settings.controller.ts`
- Test: `src/modules/admin/credit-settings-history.spec.ts`

**Interfaces:**
- Consumes: `adminsById`, `AdminRef` (Task 1).
- Produces:
  - `export const CREDIT_SETTING_FIELDS` — the 15 editable keys of `UpdateCreditSettingsDto`, as a readonly tuple.
  - `export type CreditSettingField = (typeof CREDIT_SETTING_FIELDS)[number]`
  - `export interface FieldChange { at: Date; by: AdminRef | null }`
  - `export async function lastChangedByField(prisma: PrismaService, maxEntries = 1000): Promise<Partial<Record<CreditSettingField, FieldChange>>>`
  - `GET` and `PUT /credit-settings` respond with the settings row plus `lastChanged` (serialised `at` is an ISO string).

The algorithm (the signature doesn't determine it):

```
pending = set(CREDIT_SETTING_FIELDS); found = {}; cursor = none; scanned = 0
while pending not empty and scanned < maxEntries:
  page = auditLog.findMany({ where: { action: 'credits.settings.updated' },
                              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                              take: min(200, maxEntries - scanned), cursor/skip })
  if page empty: break
  for entry in page (newest first):
    if before or after is not an object: continue
    for field in pending:
      if field in before and field in after and !sameValue(before[field], after[field]):
        found[field] = { at: entry.createdAt, actorId: entry.actorId }; pending.delete(field)
  scanned += page.length
resolve actor ids with ONE adminsById call
```

`sameValue` compares arrays element by element in order (a reorder counts as a change); scalars with `===`.

- [ ] **Step 1: Write the failing tests**

```ts
it('takes the newest change of each field', ...)                 // two entries both change adRewardCredits; newest wins
it('reports only the fields an entry actually changed', ...)      // entry changes signupBonusCredits only → no adRewardCredits key
it('treats a reordered domain list as a change, an identical one not', ...)
it('skips entries with no before, or a field missing from after', ...)
it('stops reading once every field is found', ...)               // all 15 changed in the first page → findMany called once
it('reads at most maxEntries entries', ...)                       // 5 entries, none relevant, maxEntries 3 → total `take` across calls is 3
it('names the admin with one lookup', ...)                        // adminUser.findMany called once; by.email set; unknown actor → by null
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/modules/admin/credit-settings-history.spec.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `lastChangedByField`**, then in the controller inject `PrismaService` and return `{ ...settings, lastChanged: await lastChangedByField(this.prisma) }` from both handlers (on `PUT`, after the update, so the save just made is included).

- [ ] **Step 4: Run to verify they pass**

Run: `npx jest src/modules/admin/credit-settings-history.spec.ts src/modules/credits/credit-settings.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/admin/credit-settings-history.ts src/modules/admin/credit-settings-history.spec.ts src/modules/admin/admin-credit-settings.controller.ts
git commit -m "feat(admin): credit settings say when each field last changed, and who changed it"
```

---

### Task 4: Audit entries carry `actor`, `entityLabel`, `entityDeleted`

**Files:**
- Create: `src/modules/admin/audit-labels.ts`
- Modify: `src/modules/admin/admin-audit.controller.ts`
- Test: `src/modules/admin/audit-labels.spec.ts`, `src/modules/admin/admin-audit.controller.spec.ts`

**Interfaces:**
- Consumes: `adminsById`, `AdminRef` (Task 1).
- Produces:
  - `export interface EntityLabel { label: string | null; deleted: boolean }`
  - `export async function labelEntities(prisma: PrismaService, rows: Array<{ entityType: string; entityId: string | null }>): Promise<Map<string, EntityLabel>>`, keyed `` `${entityType}:${entityId}` ``.
  - Each `GET /audit-logs` entry gains `actor: AdminRef | null` (only for `actorType === 'admin'`; otherwise `null`), `entityLabel: string | null`, `entityDeleted: boolean`. Existing fields and `meta.nextCursor` unchanged.

Label rules (one `findMany` per type present, `where: { id: { in: ids } }`):

| entityType | label | deleted |
|---|---|---|
| `Asset` | `title` | `deletedAt !== null` |
| `User` | `username ?? email ?? null` | `accountStatus === 'deleted'` |
| `Category` | `name` | `false` (missing row → label null) |
| `PricingRule` | `` `v${version}` `` | `false` |
| `ProviderCredential` | `Deepgram` / `ElevenLabs` from `provider` | `false` |
| `AdminUser` | `email` | `deletedAt !== null` |
| anything else (`CreditSettings`, `FontOrder`, …) | `null` | `false` |

A missing row gives `{ label: null, deleted: true }` for `Category`/`User`/`ProviderCredential` (removed outright), `{ label: null, deleted: false }` otherwise.

- [ ] **Step 1: Write the failing tests** (`audit-labels.spec.ts`)

```ts
it('labels each type by its rule', ...)                      // one row per table above → expected label
it('keeps a deleted sound\'s title and marks it deleted', ...)
it('gives a scrubbed user no label', ...)                    // username null, email null, accountStatus deleted → { label: null, deleted: true }
it('makes one query per type present and none for absent types', async () => {
  // 100 rows: 60 Asset, 30 User, 10 CreditSettings
  expect(prisma.asset.findMany).toHaveBeenCalledTimes(1);
  expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
  expect(prisma.category.findMany).not.toHaveBeenCalled();
});
```

In `admin-audit.controller.spec.ts`, extend the prisma fake with `adminUser`/`asset` `findMany` and add:

```ts
it('adds the actor, the entity label and whether it was deleted', async () => {
  const res = await ctl.list();
  expect(res.data[0]).toMatchObject({ actor: { email: 'owner@slimshot.dev' }, entityLabel: 'UI Button Click', entityDeleted: false });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/modules/admin/audit-labels.spec.ts src/modules/admin/admin-audit.controller.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `labelEntities`**, then in `list` map the page through `adminsById` (actor ids of admin rows) and `labelEntities`. The existing ordering, limit and cursor tests must stay green.

- [ ] **Step 4: Run to verify they pass**

Run: `npx jest src/modules/admin`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/admin/audit-labels.ts src/modules/admin/audit-labels.spec.ts src/modules/admin/admin-audit.controller.ts src/modules/admin/admin-audit.controller.spec.ts
git commit -m "feat(admin): audit entries name the admin and the item they changed"
```

---

### Task 5: Per-kind status counts and user counts

**Files:**
- Modify: `src/modules/admin/stats.service.ts`, `src/modules/admin/admin-users.service.ts`, `src/modules/admin/admin.module.ts`
- Create: `src/modules/admin/admin-user-stats.controller.ts`
- Test: `src/modules/admin/stats.service.spec.ts`, `src/modules/admin/admin-users.service.spec.ts`

**Interfaces:**
- Produces:
  - `StatsSummary` gains `byKindStatus: Record<string, Record<string, number>>` (assets with `deletedAt: null`, from one `groupBy({ by: ['kind', 'status'] })`).
  - `AdminUsersService.userStats(days: number, now = new Date()): Promise<{ total: number; newInPeriod: number }>`: both exclude `accountStatus: 'deleted'`; `newInPeriod` counts `createdAt >= startOfUtcDay(now) - (days - 1) days`, the same window `creditStats` uses.
  - `GET /api/admin/v1/stats/users?days=` (`users.read`, `days` validated by the existing `CreditStatsQueryDto`, 1–365, default 30) → `{ success: true, data: { total, newInPeriod } }`.

- [ ] **Step 1: Write the failing tests**

```ts
// stats.service.spec.ts
it('counts assets by kind and status', ...)          // groupBy rows → { audio: { published: 5, ready: 1 }, font: { published: 4 } }
it('caches the summary under a new key', ...)        // cache.wrap called with ('stats', { view: 'summary-v2' }, …)  — review focus 5
// admin-users.service.spec.ts
it('counts users and new users in the period, leaving out deleted accounts', ...)
  // user.count called twice; both where.accountStatus = { not: 'deleted' }; second has createdAt.gte = 2026-10-23T00:00:00Z for days 7, now 2026-10-29T15:00Z
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/modules/admin/stats.service.spec.ts src/modules/admin/admin-users.service.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the `groupBy` in `summary()` (cache view `'summary-v2'`), `userStats`, and the controller (registered in `AdminModule`), declared at `@Controller('api/admin/v1/stats/users')`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx jest src/modules/admin`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/admin
git commit -m "feat(admin): status counts per kind, and how many users there are"
```

---

### Task 6: Document the additions and verify

**Files:**
- Modify: `docs/admin-credits-api.md`

- [ ] **Step 1: Document** `createdBy` on pricing rules, `lastChanged` on credit settings, the audit entry fields, `byKindStatus`, and `GET /stats/users`, each with a JSON example in the file's existing style. Add a "Changelog" line dated 2026-10-29.

- [ ] **Step 2: Full verification**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all three exit 0; test count is the previous count plus the new tests, with no skipped suites.

- [ ] **Step 3: Boot check**

Run: `npm run build`
Expected: exit 0. (A container boot against a database is not available on this machine; say so in the hand-back rather than claiming it.)

- [ ] **Step 4: Commit**

```bash
git add docs/admin-credits-api.md
git commit -m "docs: admin reads for the dashboard redesign"
```
