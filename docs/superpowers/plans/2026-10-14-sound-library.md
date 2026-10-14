# Sound Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public, no-sign-in audio catalogue (categories, sounds with covers, downloads) for the app, plus the dashboard tools to categorise sounds and give them covers, on Cloudflare R2.

**Architecture:** Server: a new `catalog` module (three public routes, Redis-cached under the existing `catalog:<kind>` generation, IP rate-limited, fail-open), category assignment and an admin asset view in `AssetService`, covers through the existing ticket → R2 PUT → finalize flow with `role: thumbnail`, and a content-inspector parameter on `verifyUpload`. Dashboard: a category picker, a sound page (`/assets/[id]`) with edit + cover, the upload drawer's batch category, and a working category filter.

**Tech Stack:** NestJS 11, Prisma 7, Redis (ioredis), Jest 30 (server); Next.js 16, React 19, TanStack Query 5, shadcn/Radix, Vitest 5 (dashboard).

**Spec:** `slimshot_server/docs/superpowers/specs/2026-10-13-sound-library-design.md`

Repos: `slimshot_server` (Tasks 1–7) and `slimshot-admin` (Tasks 8–12), both on branch
`feat/sound-library` (already created, on top of `feat/r2-storage`). Run server commands in
`slimshot_server`, dashboard commands in `slimshot-admin`.

## Global Constraints

- No schema change, no migration.
- One public R2 bucket; covers under key prefix `slimshot/covers/`, audio under `slimshot/audio/`.
- No previews: never create `FileRole.preview` rows, no transcoding.
- Public routes: prefix `api/app/v1/catalog`, no auth, envelope `{ success, data, meta? }`.
- Listed asset = `status: published`, `deletedAt: null`, `visibility: public`. Downloadable = `published`, not deleted, `visibility != private`.
- Order newest first: `publishedAt desc, id desc`; `limit` 1–50, default 30; keyset cursor = last item id.
- Rate limits per IP: reads 120/min, downloads 30/min; fail-open when Redis is unreachable; 429 `RATE_LIMITED`.
- Cache: `CacheService.wrap('catalog:<kind>', …, 300)`; `bumpGeneration('catalog:<kind>')` on publish, unpublish, every asset update, soft delete, cover set/remove, every category create/update/reorder/delete.
- Download `expiresAt` = now + 10 min; `filename` = `<slug>.<format>`; entitlement = `canDownload()` returning `true`.
- Covers: `image/jpeg`, `image/png`, `image/webp`; ≤ `UPLOAD_COVER_MAX_BYTES` (default 5 MB = 5_242_880); content checked from bytes.
- Never print `.env` values; never run migrate/seed/db push against Neon; do not push or deploy.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Dashboard: shadcn/Radix dark-only, skeleton loading states (never "Loading…" text), mutations via `useMutation`.

## Review Focus

1. A refused **cover** must never mark the **sound** `failed` (the audio is fine) → test in Task 5 ("a refused cover leaves the asset's status alone").
2. An asset in a **hidden subcategory** of a visible pill must not appear in the app → test in Task 6 ("leaves out sounds in hidden subcategories").
3. **Redis down** must not 500 the public catalogue (cache and limiter both fail open) → test in Task 6 ("still answers when Redis is unreachable").
4. A cursor from **another kind or an unpublished asset** must 422, not silently restart the list → test in Task 6 ("422s a cursor that is not in this listing").
5. Assigning a **font category to an audio sound** must be refused at both update and upload → tests in Task 2 and Task 3.

---

### Task 1: Category tree helpers and cache bumps on category changes (server)

**Files:**
- Create: `src/modules/taxonomy/category-tree.ts`
- Create: `src/modules/taxonomy/category-tree.spec.ts`
- Modify: `src/modules/taxonomy/category.service.ts` (inject `CacheService`; bump after create/update/reorder/remove)
- Modify: `src/modules/taxonomy/category.service.spec.ts` (constructor arg, bump assertions)

**Interfaces:**
- Produces: `subtreeIds(rows: TreeRow[], rootId: string, opts?: { activeOnly?: boolean }): string[]` (root first; with `activeOnly`, an inactive node and its whole subtree are skipped, and an inactive root yields `[]`); `type TreeRow = { id: string; parentId: string | null; isActive: boolean }`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/modules/taxonomy/category-tree.spec.ts
import { subtreeIds } from './category-tree';

const rows = [
  { id: 'root', parentId: null, isActive: true },
  { id: 'ui', parentId: 'root', isActive: true },
  { id: 'ui-clicks', parentId: 'ui', isActive: true },
  { id: 'hidden', parentId: 'root', isActive: false },
  { id: 'under-hidden', parentId: 'hidden', isActive: true },
  { id: 'other-root', parentId: null, isActive: true },
];

describe('subtreeIds', () => {
  it('returns the node and every descendant', () => {
    expect(subtreeIds(rows, 'root').sort()).toEqual(['hidden', 'root', 'ui', 'ui-clicks', 'under-hidden']);
  });
  it('skips inactive nodes and everything under them when asked', () => {
    expect(subtreeIds(rows, 'root', { activeOnly: true }).sort()).toEqual(['root', 'ui', 'ui-clicks']);
  });
  it('returns nothing for an inactive root when only active nodes count', () => {
    expect(subtreeIds(rows, 'hidden', { activeOnly: true })).toEqual([]);
  });
  it('returns nothing for an unknown id', () => {
    expect(subtreeIds(rows, 'nope')).toEqual([]);
  });
  it('survives a cycle without looping forever', () => {
    const cyclic = [
      { id: 'a', parentId: 'b', isActive: true },
      { id: 'b', parentId: 'a', isActive: true },
    ];
    expect(subtreeIds(cyclic, 'a').sort()).toEqual(['a', 'b']);
  });
});
```

In `category.service.spec.ts`, construct the service with a third argument `cache = { bumpGeneration: jest.fn(async () => true) }` and add:

```ts
it.each([
  ['create', (svc: CategoryService) => svc.create({ kind: 'audio', name: 'UI' } as never, 'admin-1')],
  ['update', (svc: CategoryService) => svc.update('c1', { name: 'UI 2' } as never, 'admin-1')],
  ['remove', (svc: CategoryService) => svc.remove('c1', 'admin-1')],
  ['reorder', (svc: CategoryService) => svc.reorder([{ id: 'c1', sortOrder: 2 }], 'admin-1')],
])('clears the app catalogue cache after %s', async (_name, act) => {
  // build() is the spec's existing fixture: a prisma stub where category c1 is audio,
  // has no children and no assets.
  const { svc, cache } = build();
  await act(svc);
  expect(cache.bumpGeneration).toHaveBeenCalledWith('catalog:audio');
});
```

(Adapt `build()` in the existing spec to return `cache` and to make `category.findMany({ where: { id: { in } } })` answer `[{ kind: 'audio' }]` for reorder.)

- [ ] **Step 2: Run to see them fail**

Run: `npx jest src/modules/taxonomy`
Expected: FAIL — `Cannot find module './category-tree'`, and the bump assertions fail.

- [ ] **Step 3: Implement**

```ts
// src/modules/taxonomy/category-tree.ts
export interface TreeRow {
  id: string;
  parentId: string | null;
  isActive: boolean;
}

/**
 * The ids of a category and everything under it, root first. With
 * `activeOnly`, a hidden category hides its whole subtree (the app never
 * shows sounds filed under a hidden category), and a hidden root gives [].
 */
export function subtreeIds(rows: TreeRow[], rootId: string, opts: { activeOnly?: boolean } = {}): string[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const children = new Map<string, TreeRow[]>();
  for (const r of rows) {
    if (r.parentId === null) continue;
    const list = children.get(r.parentId) ?? [];
    list.push(r);
    children.set(r.parentId, list);
  }

  const root = byId.get(rootId);
  if (!root || (opts.activeOnly && !root.isActive)) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node.id);
    for (const child of children.get(node.id) ?? []) {
      if (opts.activeOnly && !child.isActive) continue;
      stack.push(child);
    }
  }
  return out;
}
```

In `category.service.ts`: add `private readonly cache: CacheService` as the third constructor parameter (import from `../../core/cache/cache.service`), add

```ts
  /** The app's catalogue lists categories and filters by them: any change must show. */
  private async invalidate(kind: AssetKind): Promise<void> {
    await this.cache.bumpGeneration(`catalog:${kind}`);
  }
```

and call it: after `create` with `dto.kind`; after `update` with the loaded row's `kind`; after `remove` with the loaded row's `kind` (keep the row from `await this.load(id)`); after `reorder` for each distinct kind of the reordered rows:

```ts
    const kinds = (await this.prisma.category.findMany({
      where: { id: { in: items.map((i) => i.id) } },
      select: { kind: true },
    })) as Array<{ kind: AssetKind }>;
    for (const kind of new Set(kinds.map((k) => k.kind))) await this.invalidate(kind);
```

- [ ] **Step 4: Run to see them pass**

Run: `npx jest src/modules/taxonomy src/modules/admin/admin-categories.controller.spec.ts`
Expected: PASS (fix `admin-categories.controller.spec.ts` construction too if it builds `CategoryService` directly).

- [ ] **Step 5: Commit**

```bash
git add src/modules/taxonomy
git commit -m "feat: category subtree helper; category changes clear the app catalogue cache"
```

---

### Task 2: Admin asset view, category assignment and list filter (server)

**Files:**
- Create: `src/modules/taxonomy/category-rules.ts`
- Create: `src/modules/taxonomy/category-rules.spec.ts`
- Modify: `src/modules/assets/dto/update-asset.dto.ts`, `src/modules/assets/dto/list-assets.dto.ts`
- Modify: `src/modules/assets/asset.service.ts`, `src/modules/assets/asset-kind.interface.ts` (`AssetWithRelations` gains the admin fields)
- Test: `src/modules/assets/asset.service.spec.ts`

**Interfaces:**
- Consumes: `subtreeIds` (Task 1).
- Produces: `assertCategoryAssignable(prisma: CategoryReader, categoryId: string, kind: AssetKind): Promise<void>` (throws 422 `VALIDATION_FAILED`); `AdminAsset = PublicAsset & { status, visibility, categoryId: string | null, createdAt: string, publishedAt: string | null }` where `files` also carries `original` and `thumbnail` when present; `AssetService.list/getById/update/publish/unpublish` return `AdminAsset`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/modules/taxonomy/category-rules.spec.ts
import { assertCategoryAssignable } from './category-rules';

const reader = (row: unknown) => ({ category: { findUnique: jest.fn(async () => row) } });

describe('assertCategoryAssignable', () => {
  it('accepts a category of the same kind, hidden or not', async () => {
    await expect(assertCategoryAssignable(reader({ kind: 'audio', isActive: false }) as never, 'c1', 'audio')).resolves.toBeUndefined();
  });
  it('refuses a category of another kind with 422', async () => {
    await expect(assertCategoryAssignable(reader({ kind: 'font', isActive: true }) as never, 'c1', 'audio')).rejects.toMatchObject({
      status: 422,
      response: { code: 'VALIDATION_FAILED', message: 'Category c1 is for font, not audio.' },
    });
  });
  it('refuses an unknown category with 422', async () => {
    await expect(assertCategoryAssignable(reader(null) as never, 'nope', 'audio')).rejects.toMatchObject({
      status: 422,
      response: { code: 'VALIDATION_FAILED', message: 'Category nope does not exist.' },
    });
  });
});
```

Add to `asset.service.spec.ts` (extend its prisma stub with `category.findUnique` / `category.findMany` and asset rows carrying `status`, `visibility`, `categoryId`, `createdAt`, `publishedAt`, files with an `original` and a `thumbnail`):

```ts
it('shows the admin the status, category, dates, original and cover', async () => {
  const view = await svc.getById('a1');
  expect(view).toMatchObject({
    status: 'ready', visibility: 'public', categoryId: 'cat-ui',
    createdAt: '2026-10-01T10:00:00.000Z', publishedAt: null,
    files: {
      original: { url: 'https://cdn.test/slimshot/audio/a.mp3', byteSize: 1000, format: 'mp3', durationMs: 412 },
      thumbnail: { url: 'https://cdn.test/slimshot/covers/c.png', byteSize: 2000, format: 'png' },
    },
  });
});

it('assigns a category of the asset kind, and clears it with null', async () => {
  await svc.update('a1', { categoryId: 'cat-ui' }, 'admin-1');
  expect(prisma.asset.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ categoryId: 'cat-ui' }) }));
  await svc.update('a1', { categoryId: null }, 'admin-1');
  expect(prisma.asset.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ categoryId: null }) }));
});

it('refuses a category of another kind', async () => {
  await expect(svc.update('a1', { categoryId: 'cat-font' }, 'admin-1')).rejects.toMatchObject({ status: 422 });
  expect(prisma.asset.update).not.toHaveBeenCalled();
});

it('clears the app catalogue cache on every update, whatever the status', async () => {
  await svc.update('a1', { title: 'New' }, 'admin-1'); // a1 is `ready`, not published
  expect(cache.bumpGeneration).toHaveBeenCalledWith('catalog:audio');
});

it('filters the list by a category and everything under it', async () => {
  await svc.list({ categoryId: 'cat-ui', limit: 25 } as never);
  expect(prisma.asset.findMany).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({ categoryId: { in: expect.arrayContaining(['cat-ui', 'cat-ui-clicks']) } }),
  }));
});

it('answers an empty page for an unknown category filter', async () => {
  const page = await svc.list({ categoryId: 'gone', limit: 25 } as never);
  expect(page).toEqual({ data: [], meta: { nextCursor: null } });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx jest src/modules/taxonomy/category-rules.spec.ts src/modules/assets/asset.service.spec.ts`
Expected: FAIL (module missing; view fields missing; categoryId not accepted).

- [ ] **Step 3: Implement**

```ts
// src/modules/taxonomy/category-rules.ts
import { HttpStatus } from '@nestjs/common';

import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import type { AssetKind } from '../../generated/prisma/enums';

export interface CategoryReader {
  category: { findUnique(args: { where: { id: string }; select: { kind: true } }): Promise<{ kind: AssetKind } | null> };
}

/**
 * A sound may be filed under any category of its own kind, hidden or not
 * (the owner can prepare a pill before showing it). Categories are
 * hard-deleted and deletion refuses while assets use them, so "exists" also
 * means "not deleted".
 */
export async function assertCategoryAssignable(db: CategoryReader, categoryId: string, kind: AssetKind): Promise<void> {
  const category = await db.category.findUnique({ where: { id: categoryId }, select: { kind: true } });
  if (!category) {
    throw appError(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.VALIDATION_FAILED, `Category ${categoryId} does not exist.`);
  }
  if (category.kind !== kind) {
    throw appError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      ErrorCode.VALIDATION_FAILED,
      `Category ${categoryId} is for ${category.kind}, not ${kind}.`,
    );
  }
}
```

`update-asset.dto.ts` — add:

```ts
  /** A category of the asset's kind; null removes it. */
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  categoryId?: string | null;
```

`list-assets.dto.ts` — add `@IsOptional() @IsString() categoryId?: string;`.

`asset.service.ts`:
- `DETAIL_INCLUDE` stays `{ files: true, audio: true }`.
- Add the view type and mapper:

```ts
export type AdminAsset = PublicAsset & {
  status: AssetStatus;
  visibility: string;
  categoryId: string | null;
  createdAt: string;
  publishedAt: string | null;
};

function fileView(f: { deliveryUrl: string | null; byteSize: number; format: string; durationMs: number | null }) {
  return {
    url: f.deliveryUrl ?? '',
    byteSize: f.byteSize,
    format: f.format,
    ...(f.durationMs !== null ? { durationMs: f.durationMs } : {}),
  };
}
```

```ts
  /** The public shape plus what only the admin may see: lifecycle, filing, and the original. */
  private toAdmin(row: AdminRow): AdminAsset {
    const base = this.kinds.get(row.kind).toPublicDto(row);
    const original = row.files.find((f) => f.role === FileRole.original);
    const thumbnail = row.files.find((f) => f.role === FileRole.thumbnail);
    return {
      ...base,
      files: {
        ...base.files,
        ...(original ? { original: fileView(original) } : {}),
        ...(thumbnail ? { thumbnail: fileView(thumbnail) } : {}),
      },
      status: row.status,
      visibility: row.visibility,
      categoryId: row.categoryId,
      createdAt: row.createdAt.toISOString(),
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    };
  }
```

  where `type AdminRow = AssetWithRelations & { status: AssetStatus; visibility: string; categoryId: string | null; createdAt: Date; publishedAt: Date | null }` (add the `role` already present on `AssetWithRelations.files`). Replace every `this.toPublic(...)` with `this.toAdmin(...)`, `load()` returns `AdminRow`, and delete `toPublic`.
- `update()`: before writing, `if (dto.categoryId) await assertCategoryAssignable(this.prisma, dto.categoryId, before.kind);`; always `await this.invalidate(before.kind)` (drop the published-only condition); audit `before: { title: before.title, categoryId: before.categoryId }`.
- `list()`: when `query.categoryId` is set:

```ts
    let categoryIds: string[] | undefined;
    if (query.categoryId) {
      const category = await this.prisma.category.findUnique({ where: { id: query.categoryId }, select: { kind: true } });
      if (!category) return { data: [], meta: { nextCursor: null } };
      const rows = await this.prisma.category.findMany({
        where: { kind: category.kind },
        select: { id: true, parentId: true, isActive: true },
      });
      categoryIds = subtreeIds(rows, query.categoryId);
    }
```

  and add `...(categoryIds ? { categoryId: { in: categoryIds } } : {})` to the `where`.

- [ ] **Step 4: Run to see them pass**

Run: `npx jest src/modules/taxonomy src/modules/assets src/modules/admin`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/taxonomy src/modules/assets
git commit -m "feat: admin asset view, category assignment and category filter"
```

---

### Task 3: Category at upload (server)

**Files:**
- Modify: `src/modules/ingest/dto/create-upload-ticket.dto.ts` (add `categoryId?`)
- Modify: `src/modules/ingest/ingest.service.ts` (`createTicket` validates and sets it)
- Test: `src/modules/ingest/ingest.service.spec.ts`

**Interfaces:**
- Consumes: `assertCategoryAssignable` (Task 2).

- [ ] **Step 1: Write the failing tests** (the spec's prisma stub gains `category.findUnique` answering `{ kind: 'audio' }` for `cat-ui`, `{ kind: 'font' }` for `cat-font`, null otherwise)

```ts
it('files the new sound under the chosen category', async () => {
  const { svc, prisma } = build();
  await svc.createTicket({ ...DTO, categoryId: 'cat-ui' }, 'admin-1');
  expect(prisma.asset.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ categoryId: 'cat-ui' }) }));
});

it('refuses a category of another kind before creating anything', async () => {
  const { svc, prisma, adapter } = build();
  await expect(svc.createTicket({ ...DTO, categoryId: 'cat-font' }, 'admin-1')).rejects.toMatchObject({ status: 422 });
  expect(prisma.asset.create).not.toHaveBeenCalled();
  expect(adapter.createUploadTicket).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run** `npx jest src/modules/ingest` — Expected: FAIL (`categoryId` unknown / not set).

- [ ] **Step 3: Implement** — DTO: `@IsOptional() @IsString() categoryId?: string;`. In `createTicket`, right after `assertAccepts`: `if (dto.categoryId) await assertCategoryAssignable(this.prisma, dto.categoryId, dto.kind);`, and in `asset.create` data: `...(dto.categoryId ? { categoryId: dto.categoryId } : {}),`.

- [ ] **Step 4: Run** `npx jest src/modules/ingest` — Expected: PASS.

- [ ] **Step 5: Commit** `git commit -am "feat: choose a sound's category at upload"`

---

### Task 4: Content inspectors and probeImage (server)

**Files:**
- Create: `src/core/storage/image-probe.ts`, `src/core/storage/image-probe.spec.ts`
- Modify: `src/core/storage/storage-adapter.interface.ts` (`ContentInspector`, `verifyUpload(key, inspect)`)
- Modify: `src/core/storage/adapters/r2.adapter.ts` (drop `deps.probe`; use the argument)
- Modify: `src/core/storage/adapters/r2.adapter.spec.ts`, `src/modules/ingest/ingest.service.ts` (pass `probeAudio`), `src/modules/ingest/ingest.service.spec.ts`

**Interfaces:**
- Produces: `type ContentInspector = (stream: Readable, size: number) => Promise<{ format: string; mimeType: string; durationMs?: number }>`; `verifyUpload(storageKey: string, inspect: ContentInspector): Promise<RemoteObject>`; `probeImage: ContentInspector` (JPEG/PNG/WebP, throws `UnreadableUploadError`).

- [ ] **Step 1: Write the failing tests**

```ts
// src/core/storage/image-probe.spec.ts
import { Readable } from 'node:stream';

import { probeImage } from './image-probe';
import { UnreadableUploadError } from './storage-adapter.interface';

const bytes = (...head: number[]) => Buffer.concat([Buffer.from(head), Buffer.alloc(64)]);
const stream = (b: Buffer) => Readable.from([b], { objectMode: false });
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(64)]);

describe('probeImage', () => {
  it.each([
    ['jpeg', bytes(0xff, 0xd8, 0xff, 0xe0), 'image/jpeg'],
    ['png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 'image/png'],
    ['webp', webp, 'image/webp'],
  ])('recognises %s from its bytes', async (format, b, mimeType) => {
    await expect(probeImage(stream(b), b.length)).resolves.toEqual({ format, mimeType });
  });

  it('refuses anything else, whatever it is called', async () => {
    const gif = Buffer.from('GIF89a' + 'x'.repeat(64));
    await expect(probeImage(stream(gif), gif.length)).rejects.toBeInstanceOf(UnreadableUploadError);
  });

  it('refuses an empty file', async () => {
    await expect(probeImage(stream(Buffer.alloc(0)), 0)).rejects.toBeInstanceOf(UnreadableUploadError);
  });

  it('lets a dropped connection through as itself', async () => {
    const broken = new Readable({ read() { this.destroy(new Error('read ECONNRESET')); } });
    await expect(probeImage(broken, 100)).rejects.toThrow('read ECONNRESET');
  });
});
```

In `r2.adapter.spec.ts`, every `new R2Adapter('prov-r2', CONFIG, { client, probe })` becomes `new R2Adapter('prov-r2', CONFIG, { client })` and every `adapter.verifyUpload(key)` becomes `adapter.verifyUpload(key, probe)`. In `ingest.service.spec.ts`, assert `expect(adapter.verifyUpload).toHaveBeenCalledWith('slimshot/audio/abc', probeAudio)` (import `probeAudio`).

- [ ] **Step 2: Run** `npx jest src/core/storage src/modules/ingest` — Expected: FAIL (module missing, arity mismatch).

- [ ] **Step 3: Implement**

```ts
// src/core/storage/image-probe.ts
import type { Readable } from 'node:stream';

import { UnreadableUploadError } from './storage-adapter.interface';

const HEAD_BYTES = 12;

/** The first `n` bytes of a stream (fewer if it ends sooner). Stream errors propagate as themselves. */
async function readHead(stream: Readable, n: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    chunks.push(b);
    total += b.length;
    if (total >= n) break;
  }
  return Buffer.concat(chunks).subarray(0, n);
}

function detect(head: Buffer): { format: string; mimeType: string } | undefined {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { format: 'jpeg', mimeType: 'image/jpeg' };
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { format: 'png', mimeType: 'image/png' };
  }
  if (head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') {
    return { format: 'webp', mimeType: 'image/webp' };
  }
  return undefined;
}

/**
 * A cover's real type, from its first bytes. Only JPEG, PNG and WebP are
 * accepted: what Android's image loaders all decode.
 */
export async function probeImage(stream: Readable, size: number): Promise<{ format: string; mimeType: string }> {
  try {
    const head = size > 0 ? await readHead(stream, HEAD_BYTES) : Buffer.alloc(0);
    const type = detect(head);
    if (!type) throw new UnreadableUploadError('The file is not a supported image (JPEG, PNG or WebP).');
    return type;
  } finally {
    stream.destroy();
  }
}
```

Interface (in `storage-adapter.interface.ts`): add `import type { Readable } from 'node:stream';`, the `ContentInspector` type, and change `verifyUpload(storageKey: string): …` to `verifyUpload(storageKey: string, inspect: ContentInspector): Promise<RemoteObject>;` (keep the doc comment: an `UnreadableUploadError` from `inspect` passes through).

R2 adapter: remove `probe` from `R2Deps` and the `this.probe` field; `verifyUpload(storageKey, inspect)` calls `const { format, mimeType, durationMs } = await inspect(object.Body as Readable, byteSize);` and returns `...(durationMs !== undefined ? { durationMs } : {})`. Remove the `probeAudio` import from the adapter.

Ingest: `remote = await adapter.verifyUpload(session.storageKey, probeAudio);` (import from `../../core/storage/audio-probe`).

- [ ] **Step 4: Run** `npx jest src/core/storage src/modules/ingest` — Expected: PASS.

- [ ] **Step 5: Commit** `git commit -am "refactor: verifyUpload takes the content inspector; add probeImage"` (add the new files first).

---

### Task 5: Covers — ticket, finalize, remove (server)

**Files:**
- Modify: `src/config/env.validation.ts` (`UPLOAD_COVER_MAX_BYTES`, default 5_242_880, min 1, max 52_428_800), `src/config/upload.config.ts` (add `cover: { maxBytes, mimeTypes: ['image/jpeg','image/png','image/webp'] }`), `src/config/env.validation.spec.ts` (default asserted), `.env.example`, `.env.production.example` (one commented line each: `UPLOAD_COVER_MAX_BYTES=5242880`)
- Modify: `src/modules/ingest/dto/create-upload-ticket.dto.ts` (`role?`, `assetId?`; `kind` required only for originals)
- Modify: `src/modules/ingest/ingest.service.ts` (cover ticket, cover finalize, `removeCover`, `CacheService` injected, `refuse` gains `markFailed`)
- Modify: `src/modules/admin/admin-assets.controller.ts` (`DELETE :id/cover`, 204, `asset.update`)
- Test: `src/modules/ingest/ingest.service.spec.ts`, `src/modules/admin/admin-assets.http.spec.ts` (new)

**Interfaces:**
- Consumes: `probeImage`, `ContentInspector` (Task 4).
- Produces: ticket body `{ role: 'thumbnail', assetId, filename, mimeType, byteSize }`; `IngestService.removeCover(assetId: string, actorId: string): Promise<void>`; route `DELETE /api/admin/v1/assets/:id/cover` → 204.

- [ ] **Step 1: Write the failing tests** (in `ingest.service.spec.ts`; the builder gains `cache = { bumpGeneration: jest.fn(async () => true) }` as the 7th constructor argument, `prisma.asset.findFirst` answering `{ id: 'asset-1', kind: 'audio', status: 'published', deletedAt: null }`, `prisma.assetFile.findMany/deleteMany`, and `storage.get` returning the adapter)

```ts
describe('IngestService covers', () => {
  const COVER = { role: 'thumbnail', assetId: 'asset-1', filename: 'cover.PNG', mimeType: 'image/png', byteSize: 20_000 };
  function coverSession(overrides = {}) {
    return { id: 'sess-c', assetId: 'asset-1', role: FileRole.thumbnail, storageId: 'prov-1', storageKey: 'slimshot/covers/new.png',
      state: 'pending', expiresAt: new Date(Date.now() + 600_000), declaredMime: 'image/png', declaredSize: 20_000,
      createdById: 'admin-1', asset: { kind: AssetKind.audio, status: 'published' }, ...overrides };
  }
  const COVER_REMOTE = { storageKey: 'slimshot/covers/new.png', byteSize: 20_000, format: 'png', mimeType: 'image/png', deliveryUrl: 'https://cdn.test/slimshot/covers/new.png' };

  it('tickets a cover for an existing sound without creating a new asset', async () => {
    const { svc, prisma, adapter } = build();
    const res = await svc.createTicket(COVER as never, 'admin-1');
    expect(prisma.asset.create).not.toHaveBeenCalled();
    expect(adapter.createUploadTicket).toHaveBeenCalledWith(expect.objectContaining({ folder: 'slimshot/covers', mimeType: 'image/png', byteSize: 20_000 }));
    expect(prisma.uploadSession.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ assetId: 'asset-1', role: 'thumbnail' }) }));
    expect(res.assetId).toBe('asset-1');
  });

  it.each([
    ['a type that is not an image', { mimeType: 'image/gif' }, /not an accepted cover type/],
    ['a cover over the cap', { byteSize: 5_242_881 }, /exceeds the cover maximum/],
  ])('refuses %s at ticket time', async (_n, patch, message) => {
    const { svc } = build();
    await expect(svc.createTicket({ ...COVER, ...patch } as never, 'admin-1')).rejects.toThrow(message);
  });

  it('404s a cover ticket for an unknown or deleted sound', async () => {
    const { svc, prisma } = build();
    prisma.asset.findFirst.mockResolvedValueOnce(null);
    await expect(svc.createTicket(COVER as never, 'admin-1')).rejects.toMatchObject({ status: 404 });
  });

  it('replaces the old cover: new row in, old row and file out, cache cleared', async () => {
    const { svc, prisma, adapter, cache } = build({ session: coverSession() });
    adapter.verifyUpload.mockResolvedValue(COVER_REMOTE as never);
    prisma.assetFile.findMany.mockResolvedValue([{ id: 'f-old', storageId: 'prov-1', storageKey: 'slimshot/covers/old.png' }]);

    await svc.finalize({ sessionId: 'sess-c' }, 'admin-1');

    expect(adapter.verifyUpload).toHaveBeenCalledWith('slimshot/covers/new.png', probeImage);
    expect(prisma.assetFile.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['f-old'] } } });
    expect(prisma.assetFile.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ role: 'thumbnail', storageKey: 'slimshot/covers/new.png' }) }));
    expect(adapter.delete).toHaveBeenCalledWith('slimshot/covers/old.png');
    expect(cache.bumpGeneration).toHaveBeenCalledWith('catalog:audio');
    expect(prisma.asset.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: expect.anything() }) }));
  });

  it('a refused cover leaves the asset status alone and removes only the new file', async () => {
    const { svc, prisma, adapter } = build({ session: coverSession() });
    adapter.verifyUpload.mockRejectedValue(new UnreadableUploadError('The file is not a supported image (JPEG, PNG or WebP).'));
    await expect(svc.finalize({ sessionId: 'sess-c' }, 'admin-1')).rejects.toThrow('not a supported image');
    expect(prisma.asset.update).not.toHaveBeenCalled();
    expect(adapter.delete).toHaveBeenCalledWith('slimshot/covers/new.png');
    expect(adapter.delete).toHaveBeenCalledTimes(1);
  });

  it('refuses a PNG that was declared as JPEG', async () => {
    const { svc, adapter } = build({ session: coverSession({ declaredMime: 'image/jpeg' }) });
    adapter.verifyUpload.mockResolvedValue(COVER_REMOTE as never);
    await expect(svc.finalize({ sessionId: 'sess-c' }, 'admin-1')).rejects.toThrow('The file is PNG (image/png), but it was uploaded as image/jpeg.');
  });

  it('keeps the new cover when deleting the old file fails', async () => {
    const { svc, prisma, adapter } = build({ session: coverSession() });
    adapter.verifyUpload.mockResolvedValue(COVER_REMOTE as never);
    prisma.assetFile.findMany.mockResolvedValue([{ id: 'f-old', storageId: 'prov-1', storageKey: 'slimshot/covers/old.png' }]);
    adapter.delete.mockRejectedValue(new Error('R2 unreachable'));
    await expect(svc.finalize({ sessionId: 'sess-c' }, 'admin-1')).resolves.toMatchObject({ assetId: 'asset-1' });
  });

  it('removes a cover: rows, files and cache', async () => {
    const { svc, prisma, adapter, cache } = build();
    prisma.assetFile.findMany.mockResolvedValue([{ id: 'f-old', storageId: 'prov-1', storageKey: 'slimshot/covers/old.png' }]);
    await svc.removeCover('asset-1', 'admin-1');
    expect(prisma.assetFile.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['f-old'] } } });
    expect(adapter.delete).toHaveBeenCalledWith('slimshot/covers/old.png');
    expect(cache.bumpGeneration).toHaveBeenCalledWith('catalog:audio');
  });
});
```

HTTP spec `src/modules/admin/admin-assets.http.spec.ts` (pattern of `admin-pricing-rules.http.spec.ts`): controller `AdminAssetsController`, providers `AssetService` and `IngestService` stubs; assert `DELETE /api/admin/v1/assets/a1/cover` → 204 and `ingest.removeCover` called with `('a1', 'admin-1')`; assert a ticket body `{ role: 'thumbnail', assetId: 'a1', filename: 'c.png', mimeType: 'image/png', byteSize: 10 }` passes validation (201) and `{ role: 'preview', … }` is 422.

- [ ] **Step 2: Run** `npx jest src/modules/ingest src/modules/admin src/config` — Expected: FAIL.

- [ ] **Step 3: Implement**

DTO:

```ts
  /** `thumbnail` uploads a cover for an existing asset (`assetId`); default `original` creates a new asset. */
  @IsOptional()
  @IsIn([FileRole.original, FileRole.thumbnail])
  role?: FileRole;

  @ValidateIf((o: CreateUploadTicketDto) => o.role === FileRole.thumbnail)
  @IsString()
  assetId?: string;
```

and make `kind` `@ValidateIf((o) => o.role !== FileRole.thumbnail) @IsEnum(AssetKind) kind!: AssetKind;`.

Service (key parts; keep the existing audio paths as they are):

```ts
  async createTicket(dto: CreateUploadTicketDto, actorId: string): Promise<TicketResponse> {
    if (dto.role === FileRole.thumbnail) return this.createCoverTicket(dto, actorId);
    // … existing body unchanged …
  }

  private async createCoverTicket(dto: CreateUploadTicketDto, actorId: string): Promise<TicketResponse> {
    const { maxBytes, mimeTypes } = this.upload.cover;
    if (!mimeTypes.includes(dto.mimeType)) {
      throw new BadRequestException(`${dto.mimeType} is not an accepted cover type. Allowed: ${mimeTypes.join(', ')}`);
    }
    if (dto.byteSize > maxBytes) {
      throw new BadRequestException(`File size ${dto.byteSize} exceeds the cover maximum of ${maxBytes} bytes.`);
    }
    const asset = await this.prisma.asset.findFirst({ where: { id: dto.assetId!, deletedAt: null } });
    if (!asset) throw new NotFoundException(`Asset not found: ${dto.assetId}`);

    const adapter = await this.storage.getDefault();
    const ticket = await adapter.createUploadTicket({
      folder: 'slimshot/covers', filename: dto.filename, mimeType: dto.mimeType, byteSize: dto.byteSize,
      ttlSeconds: this.upload.ticketTtlSeconds,
    });
    const session = await this.prisma.uploadSession.create({
      data: {
        assetId: asset.id, role: FileRole.thumbnail, storageId: adapter.id, storageKey: ticket.storageKey,
        expiresAt: ticket.expiresAt, declaredMime: dto.mimeType, declaredSize: dto.byteSize, createdById: actorId,
      },
    });
    await this.audit.record({ actorId, actorType: 'admin', action: 'asset.cover.ticket', entityType: 'Asset', entityId: asset.id });
    return {
      assetId: asset.id, sessionId: session.id, uploadUrl: ticket.uploadUrl, method: ticket.method,
      headers: ticket.headers, storageKey: ticket.storageKey, expiresAt: ticket.expiresAt,
    };
  }
```

In `finalize`, after the ownership/state/expiry checks and `const adapter = …`, branch: `if (session.role === FileRole.thumbnail) return this.finalizeCover(session, adapter, actorId);`.

```ts
  private async finalizeCover(
    session: { id: string; assetId: string; storageId: string; storageKey: string; declaredMime: string; asset: { kind: AssetKind; status: AssetStatus } },
    adapter: StorageProviderAdapter,
    actorId: string,
  ): Promise<{ assetId: string; status: AssetStatus }> {
    const keepStatus = { markFailed: false };
    let remote;
    try {
      remote = await adapter.verifyUpload(session.storageKey, probeImage);
    } catch (error) {
      if (error instanceof UnreadableUploadError) await this.refuse(session, adapter, error.message, keepStatus);
      throw new BadRequestException(`Upload could not be verified in storage: ${(error as Error).message}`);
    }
    const { maxBytes, mimeTypes } = this.upload.cover;
    if (!mimeTypes.includes(remote.mimeType)) {
      await this.refuse(session, adapter, `${remote.mimeType} is not an accepted cover type.`, keepStatus);
    }
    if (remote.mimeType !== session.declaredMime) {
      await this.refuse(session, adapter,
        `The file is ${remote.format.toUpperCase()} (${remote.mimeType}), but it was uploaded as ${session.declaredMime}.`, keepStatus);
    }
    if (remote.byteSize > maxBytes) {
      await this.refuse(session, adapter, `File size ${remote.byteSize} exceeds the cover maximum of ${maxBytes} bytes.`, keepStatus);
    }

    const previous = await this.prisma.$transaction(async (tx) => {
      const old = (await tx.assetFile.findMany({
        where: { assetId: session.assetId, role: FileRole.thumbnail },
        select: { id: true, storageId: true, storageKey: true },
      })) as StoredFile[];
      if (old.length > 0) await tx.assetFile.deleteMany({ where: { id: { in: old.map((f) => f.id) } } });
      await tx.assetFile.create({
        data: {
          assetId: session.assetId, role: FileRole.thumbnail, storageId: session.storageId, storageKey: remote.storageKey,
          deliveryUrl: remote.deliveryUrl, mimeType: remote.mimeType, format: remote.format, byteSize: remote.byteSize, isPrimary: false,
        },
      });
      await tx.uploadSession.update({ where: { id: session.id }, data: { state: 'finalized', finalizedAt: new Date() } });
      return old;
    });

    await this.deleteStored(previous);
    await this.cache.bumpGeneration(`catalog:${session.asset.kind}`);
    await this.audit.record({ actorId, actorType: 'admin', action: 'asset.cover.set', entityType: 'Asset', entityId: session.assetId });
    return { assetId: session.assetId, status: session.asset.status };
  }

  async removeCover(assetId: string, actorId: string): Promise<void> {
    const asset = await this.prisma.asset.findFirst({ where: { id: assetId, deletedAt: null } });
    if (!asset) throw new NotFoundException(`Asset not found: ${assetId}`);
    const old = (await this.prisma.assetFile.findMany({
      where: { assetId, role: FileRole.thumbnail },
      select: { id: true, storageId: true, storageKey: true },
    })) as StoredFile[];
    if (old.length > 0) await this.prisma.assetFile.deleteMany({ where: { id: { in: old.map((f) => f.id) } } });
    await this.deleteStored(old);
    await this.cache.bumpGeneration(`catalog:${asset.kind}`);
    await this.audit.record({ actorId, actorType: 'admin', action: 'asset.cover.remove', entityType: 'Asset', entityId: assetId });
  }

  /** Best effort: the rows are already gone, so a leftover object is only wasted space. */
  private async deleteStored(files: StoredFile[]): Promise<void> {
    for (const f of files) {
      try {
        await (await this.storage.get(f.storageId)).delete(f.storageKey);
      } catch (error) {
        this.logger.warn(`Could not delete replaced cover ${f.storageKey}: ${(error as Error).message}`);
      }
    }
  }
```

with `type StoredFile = { id: string; storageId: string; storageKey: string }`, a `private readonly logger = new Logger(IngestService.name)`, `CacheService` as the 7th constructor parameter, and `refuse(session, adapter, reason, opts = { markFailed: true })` calling `markFailed` only when `opts.markFailed`. The audio paths keep calling `refuse` without options. The existing verify-error path for audio still marks failed; the cover path above must not (it does not call `markFailed`).

Controller:

```ts
  @Delete(':id/cover')
  @HttpCode(204)
  @RequirePermission('asset.update')
  async removeCover(@Param('id') id: string, @CurrentUser() user: AccessTokenClaims): Promise<void> {
    await this.ingest.removeCover(id, user.sub);
  }
```

(declare it before `@Delete(':id')` so Nest matches the longer path first.)

- [ ] **Step 4: Run** `npx jest src/modules/ingest src/modules/admin src/config` — Expected: PASS. Then `npx tsc --noEmit -p tsconfig.build.json`.

- [ ] **Step 5: Commit** `git add -A src .env.example .env.production.example && git commit -m "feat: sound covers through the upload ticket flow; replace and remove"`

---

### Task 6: Public catalogue module (server)

**Files:**
- Create: `src/modules/catalog/catalog.module.ts`, `catalog.controller.ts`, `catalog.service.ts`, `entitlement.ts`, `catalog-limits.ts`, `dto/catalog-query.dto.ts`
- Create: `src/modules/catalog/catalog.service.spec.ts`, `src/modules/catalog/catalog.http.spec.ts`
- Modify: `src/app.module.ts` (import `CatalogModule`)

**Interfaces:**
- Consumes: `subtreeIds` (Task 1), `CacheService.wrap/bumpGeneration`, `RateLimiter.hit`, `IdentityHashService.hash`.
- Produces: `CatalogService.categories(kind, rootSlug): Promise<CatalogCategory[]>`, `.assets(q): Promise<{ items: CatalogItem[]; nextCursor: string | null }>`, `.download(id): Promise<DownloadTicket>`; `canDownload(asset: { id: string }): boolean`; token `CATALOG_LIMITS` = `{ readPerMinute: 120, downloadPerMinute: 30 }`.

Types:

```ts
export interface CatalogCategory { id: string; slug: string; name: string; children: CatalogCategory[] }
export interface CatalogItem {
  id: string; slug: string; title: string; author: string; durationMs: number;
  category: { slug: string; name: string } | null; cover: { url: string } | null;
}
export interface DownloadTicket { url: string; expiresAt: string; filename: string; format: string; byteSize: number; durationMs: number }
```

- [ ] **Step 1: Write the failing service tests** (`catalog.service.spec.ts`, real `CacheService` over `FakeRedis` from `test/fakes/fake-redis.ts`; an in-memory prisma stub with categories `sfx` (root, `sound-effects`), `ui` (child, active), `ui-clicks` (grandchild, active), `hidden` (child, inactive), `under-hidden` (child of hidden), and assets covering every listing state)

Test cases, each its own `it`:
1. `categories('audio','sound-effects')` returns `[{ id:'ui', slug:'ui', name:'UI', children:[{ slug:'ui-clicks', … children: [] }] }]` — hidden subtree absent, `sortOrder` respected (add a second active child with lower `sortOrder` and assert it comes first).
2. `categories` 404s (`NotFoundException`/status 404, code `NOT_FOUND`) for an unknown root, an inactive root, and a root that has a parent.
3. `assets({ kind:'audio', category:'sound-effects' })` returns only published + public + not-deleted assets (fixtures: draft, ready, published-unlisted, published-private, published-deleted, published-public ×3) — exactly the three.
4. "leaves out sounds in hidden subcategories": an asset filed under `under-hidden` is absent when listing `sound-effects`.
5. category `ui` includes `ui-clicks` assets; category `hidden` → 404.
6. never exposes the original: `JSON.stringify(result)` does not contain the original's URL; item keys equal exactly `['author','category','cover','durationMs','id','slug','title']`.
7. newest first with keyset paging: 5 assets, `limit: 2` → pages of ids `[e,d]`, `[c,b]`, `[a]`, `nextCursor` null on the last; two assets with the same `publishedAt` ordered by id desc.
8. "422s a cursor that is not in this listing": cursor = an unpublished asset id → status 422 code `VALIDATION_FAILED`; cursor = an id of a `font` asset → 422.
9. cover is `{ url }` from the thumbnail row's `deliveryUrl`, `null` without one; `category` is `{ slug, name }`, `null` when unfiled (list without `category`).
10. cached: a second identical call does not hit prisma (`asset.findMany` called once); after `cache.bumpGeneration('catalog:audio')` it hits prisma again.
11. `download('a1')` returns `{ url: <original deliveryUrl>, filename: '<slug>.mp3', format:'mp3', byteSize, durationMs }`, `expiresAt` = now + 10 min (fake timers), increments `downloadCount` (`asset.update` with `{ downloadCount: { increment: 1 } }`).
12. `download` 404s for unknown, draft, deleted and private; succeeds for unlisted.
13. `download` 403 `FORBIDDEN` when `canDownload` returns false (`jest.spyOn(entitlement, 'canDownload').mockReturnValue(false)`; import entitlement as a namespace in the service so the spy takes effect).

- [ ] **Step 2: Run** `npx jest src/modules/catalog` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement the service**

```ts
// src/modules/catalog/entitlement.ts
/**
 * The one place that decides who may download a catalogue file. Everyone may,
 * today. Gating later (sign-in, credits, premium packs) changes this function
 * only; callers already 403 when it says no.
 */
export function canDownload(_asset: { id: string }): boolean {
  return true;
}
```

```ts
// src/modules/catalog/catalog-limits.ts
export const CATALOG_LIMITS = Symbol('CATALOG_LIMITS');
export interface CatalogLimits { readPerMinute: number; downloadPerMinute: number }
export const DEFAULT_CATALOG_LIMITS: CatalogLimits = { readPerMinute: 120, downloadPerMinute: 30 };
```

```ts
// src/modules/catalog/catalog.service.ts (essentials)
const CACHE_TTL_SECONDS = 300;
const DOWNLOAD_URL_LIFETIME_MS = 10 * 60 * 1000;
const LISTED = { status: AssetStatus.published, deletedAt: null, visibility: Visibility.public } as const;

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService, private readonly cache: CacheService) {}

  categories(kind: AssetKind, rootSlug: string): Promise<CatalogCategory[]> {
    return this.cache.wrap(`catalog:${kind}`, ['categories', rootSlug], async () => {
      const rows = await this.prisma.category.findMany({
        where: { kind },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: { id: true, parentId: true, slug: true, name: true, isActive: true },
      });
      const root = rows.find((r) => r.slug === rootSlug && r.parentId === null && r.isActive);
      if (!root) throw notFound(`No category "${rootSlug}" for ${kind}.`);
      const build = (parentId: string): CatalogCategory[] =>
        rows
          .filter((r) => r.parentId === parentId && r.isActive)
          .map((r) => ({ id: r.id, slug: r.slug, name: r.name, children: build(r.id) }));
      return build(root.id);
    }, CACHE_TTL_SECONDS);
  }

  assets(q: { kind: AssetKind; category?: string; cursor?: string; limit: number }) {
    return this.cache.wrap(`catalog:${q.kind}`, ['assets', q.category ?? null, q.cursor ?? null, q.limit], () => this.loadAssets(q), CACHE_TTL_SECONDS);
  }

  private async loadAssets(q: { kind: AssetKind; category?: string; cursor?: string; limit: number }) {
    let categoryIds: string[] | undefined;
    if (q.category) {
      const rows = await this.prisma.category.findMany({ where: { kind: q.kind }, select: { id: true, parentId: true, isActive: true, slug: true } });
      const start = rows.find((r) => r.slug === q.category && r.isActive);
      if (!start) throw notFound(`No category "${q.category}" for ${q.kind}.`);
      categoryIds = subtreeIds(rows, start.id, { activeOnly: true });
    }

    const where: Prisma.AssetWhereInput = { kind: q.kind, ...LISTED, ...(categoryIds ? { categoryId: { in: categoryIds } } : {}) };
    if (q.cursor) {
      const at = await this.prisma.asset.findFirst({ where: { id: q.cursor, ...where }, select: { id: true, publishedAt: true } });
      if (!at?.publishedAt) throw invalid(`Cursor ${q.cursor} is not in this listing.`);
      where.AND = [{ OR: [{ publishedAt: { lt: at.publishedAt } }, { publishedAt: at.publishedAt, id: { lt: at.id } }] }];
    }

    const rows = await this.prisma.asset.findMany({
      where,
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      include: { audio: true, category: { select: { slug: true, name: true } }, files: { where: { role: FileRole.thumbnail }, take: 1 } },
    });
    const page = rows.slice(0, q.limit);
    return {
      items: page.map((a): CatalogItem => ({
        id: a.id, slug: a.slug, title: a.title, author: a.authorName,
        durationMs: a.audio?.durationMs ?? 0,
        category: a.category ? { slug: a.category.slug, name: a.category.name } : null,
        cover: a.files[0]?.deliveryUrl ? { url: a.files[0].deliveryUrl } : null,
      })),
      nextCursor: rows.length > q.limit ? page[page.length - 1].id : null,
    };
  }

  async download(id: string): Promise<DownloadTicket> {
    const asset = await this.prisma.asset.findFirst({
      where: { id, status: AssetStatus.published, deletedAt: null, visibility: { not: Visibility.private } },
      include: { audio: true, files: { where: { role: FileRole.original }, take: 1 } },
    });
    const original = asset?.files[0];
    if (!asset || !original?.deliveryUrl) throw notFound(`Asset not found: ${id}`);
    if (!entitlement.canDownload(asset)) throw appError(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, 'This sound cannot be downloaded.');

    await this.prisma.asset.update({ where: { id }, data: { downloadCount: { increment: 1 } } });
    return {
      url: original.deliveryUrl,
      expiresAt: new Date(Date.now() + DOWNLOAD_URL_LIFETIME_MS).toISOString(),
      filename: `${asset.slug}.${original.format}`,
      format: original.format,
      byteSize: original.byteSize,
      durationMs: original.durationMs ?? asset.audio?.durationMs ?? 0,
    };
  }
}

const notFound = (m: string) => appError(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, m);
const invalid = (m: string) => appError(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.VALIDATION_FAILED, m);
```

(`import * as entitlement from './entitlement'`; import `Prisma` from `../../generated/prisma/client`; a thrown error inside `cache.wrap`'s factory propagates and is not cached — verify `wrap` only stores successful results.)

- [ ] **Step 4: Run** `npx jest src/modules/catalog/catalog.service.spec.ts` — Expected: PASS.

- [ ] **Step 5: Write the failing HTTP tests** (`catalog.http.spec.ts`: real controller, real `RateLimiter` over `FakeRedis` provided as `REDIS`, `CATALOG_LIMITS` = `{ readPerMinute: 3, downloadPerMinute: 2 }`, `IdentityHashService` stub `{ hash: (_k, v) => v }`, `CatalogService` stub)

Cases: `GET /api/app/v1/catalog/categories?kind=audio&root=sound-effects` → 200 `{ success: true, data: [...] }`; missing `root` → 422; `kind=video` → 422; service throwing 404 → 404 envelope `{ success:false, error:{ code:'NOT_FOUND' } }`; `GET /catalog/assets?kind=audio&limit=51` → 422, `limit=0` → 422, default limit passes `30` to the service; success shape `{ success:true, data:[…], meta:{ nextCursor } }`; `POST /catalog/assets/a1/download` → 200 (not 201) with the ticket; reads over the limit → 429 `RATE_LIMITED` with `details.retryAfterSeconds`; downloads have their own bucket (3 reads then 2 downloads still pass, 3rd download 429); "still answers when Redis is unreachable": a REDIS whose `incr` rejects → 200.

- [ ] **Step 6: Run** `npx jest src/modules/catalog/catalog.http.spec.ts` — Expected: FAIL (no controller).

- [ ] **Step 7: Implement DTOs, controller, module**

```ts
// dto/catalog-query.dto.ts
export class CatalogCategoriesQueryDto {
  @IsEnum(AssetKind) kind!: AssetKind;
  @IsString() @MinLength(1) @MaxLength(100) root!: string;
}
export class CatalogAssetsQueryDto {
  @IsEnum(AssetKind) kind!: AssetKind;
  @IsOptional() @IsString() @MaxLength(100) category?: string;
  @IsOptional() @IsString() @MaxLength(64) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit: number = 30;
}
```

```ts
// catalog.controller.ts
@Controller('api/app/v1/catalog')
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly limiter: RateLimiter,
    private readonly hashes: IdentityHashService,
    @Inject(CATALOG_LIMITS) private readonly limits: CatalogLimits,
  ) {}

  @Get('categories')
  async categories(@Query() q: CatalogCategoriesQueryDto, @Ip() ip: string) {
    await this.limit('read', ip, this.limits.readPerMinute);
    return { success: true as const, data: await this.catalog.categories(q.kind, q.root) };
  }

  @Get('assets')
  async assets(@Query() q: CatalogAssetsQueryDto, @Ip() ip: string) {
    await this.limit('read', ip, this.limits.readPerMinute);
    const { items, nextCursor } = await this.catalog.assets(q);
    return { success: true as const, data: items, meta: { nextCursor } };
  }

  @Post('assets/:id/download')
  @HttpCode(200)
  async download(@Param('id') id: string, @Ip() ip: string) {
    await this.limit('download', ip, this.limits.downloadPerMinute);
    return { success: true as const, data: await this.catalog.download(id) };
  }

  /** Per IP. Fails open: a Redis outage must not take the public catalogue down. */
  private async limit(bucket: 'read' | 'download', ip: string | undefined, perMinute: number): Promise<void> {
    try {
      await this.limiter.hit(`catalog:${bucket}:${this.hashes.hash('ip', ip ?? 'unknown')}`, perMinute, 60);
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === HttpStatus.TOO_MANY_REQUESTS) throw error;
    }
  }
}
```

```ts
// catalog.module.ts
@Module({
  controllers: [CatalogController],
  providers: [CatalogService, RateLimiter, { provide: CATALOG_LIMITS, useValue: DEFAULT_CATALOG_LIMITS }],
})
export class CatalogModule {}
```

Add `CatalogModule` to `AppModule.imports` (after `TaxonomyModule`).

- [ ] **Step 8: Run** `npx jest src/modules/catalog && npx tsc --noEmit -p tsconfig.build.json` — Expected: PASS, no type errors.

- [ ] **Step 9: Commit** `git add -A src/modules/catalog src/app.module.ts && git commit -m "feat: public sound catalogue API (categories, sounds, downloads)"`

---

### Task 7: Contract doc for the app; server suite gate (server)

**Files:**
- Create: `docs/app-catalog-api.md`

The doc must contain, in this order: (1) overview and base URL `https://slimshot-server.techfamz.com/api/app/v1/catalog`, no auth; (2) the `sound-effects` root convention, and that the app must not hardcode any other category; (3) each endpoint — method, path, query/body, a full success JSON example copied from what the HTTP spec asserts, every error with status + code + example body; (4) paging rules (keyset, `limit` 1–50 default 30, pass `meta.nextCursor` back as `cursor`, stop at `null`, never build cursors); (5) download flow — call download when the user taps, fetch `url` immediately, save the file in the app's library, never store or reuse `url`, `filename`/`format` for the saved name, show nothing for `durationMs` 0; (6) covers — `cover` may be `null`, show the fallback tile; (7) caching — server caches 5 min but publishing/editing clears it immediately, so a pull-to-refresh shows changes; (8) rate limits — 120 reads/min, 30 downloads/min per IP, 429 with `details.retryAfterSeconds`, back off; (9) what not to rely on — URL shapes or hosts, a `url` past `expiresAt`, order beyond newest-first, undocumented fields, field order; (10) changelog line for this first version.

- [ ] **Step 1:** Write the doc from the HTTP spec's real responses.
- [ ] **Step 2:** Full server gate: `npx tsc --noEmit -p tsconfig.build.json && npx eslint src --max-warnings 0 && npx jest` — Expected: all green; compare the test count with the 708 baseline (must only grow).
- [ ] **Step 3: Commit** `git add docs/app-catalog-api.md && git commit -m "docs: app contract for the sound catalogue API"`

---

### Task 8: Dashboard API client (dashboard)

**Files:**
- Modify: `lib/api/assets.ts`, `lib/api/assets.test.ts`

**Interfaces:**
- Produces:
  - `Asset` gains `coverUrl: string | null`; `status` comes from the server (`row.status ?? activeStatus ?? null`), `categoryId`/`createdAt` from the server.
  - `AssetDetail = Asset & { slug: string; byteSize: number | null; format: string | null; originalUrl: string | null; publishedAt: string | null }`.
  - `fetchAssets(filters)` sends `categoryId`.
  - `fetchAsset(id): Promise<AssetDetail>` (GET `/assets/:id`).
  - `updateAsset(id, patch: { title?: string; authorName?: string; categoryId?: string | null }): Promise<AssetDetail>` (PATCH).
  - `removeCover(id): Promise<void>` (DELETE `/assets/:id/cover`).

- [ ] **Step 1: Failing tests** in `lib/api/assets.test.ts`: replace the two tests that pin "categoryId is never sent" with: `fetchAssets({ categoryId: 'c1' })` requests `/assets?categoryId=c1`; a server row with `status`, `categoryId`, `createdAt`, `files.thumbnail.url` maps to `status:'ready'`, `categoryId:'c1'`, `createdAt`, `coverUrl`; `fetchAsset('a1')` maps `files.original` to `originalUrl/byteSize/format`; `updateAsset('a1', { categoryId: null })` sends PATCH with body `{"categoryId":null}`; `removeCover('a1')` sends DELETE `/assets/a1/cover` and resolves on 204.
- [ ] **Step 2: Run** `npx vitest run lib/api/assets.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** — extend `ServerAsset` with `status?`, `visibility?`, `categoryId?`, `createdAt?`, `publishedAt?` and `files` entries carrying `byteSize`/`format`; rewrite `toAsset`; send `categoryId` in `fetchAssets`; add the three functions using `withRefresh(() => apiFetch(…))` (DELETE: use the client's existing empty-body handling — check `apiFetch` on 204 and handle `undefined`). Delete the R8f comments that no longer hold, and replace the module comment with one line: the admin API returns the admin view (spec §5.2).
- [ ] **Step 4: Run** `npx vitest run lib/api` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "feat: dashboard client for the admin asset view, edits and covers"`

---

### Task 9: Category picker and the asset list's category filter (dashboard)

**Files:**
- Modify: `lib/categories/tree-helpers.ts` (+ `flattenWithDepth`), `lib/categories/tree-helpers.test.ts`
- Create: `components/categories/category-picker.tsx`, `components/categories/category-picker.test.tsx`
- Modify: `components/assets/asset-filters.tsx` (picker replaces the notice; `activeCount` counts it), `components/assets/asset-filters.test.tsx`

**Interfaces:**
- Produces: `flattenWithDepth(nodes: Category[]): Array<Category & { depth: number }>` (pre-order, uses `buildTree` order); `<CategoryPicker kind value onChange label? noneLabel? />` with `value: string | null`, `onChange(id: string | null)`.

- [ ] **Step 1: Failing tests**
  - `flattenWithDepth`: a 3-level tree flattens pre-order with depths 0,1,2 in `sortOrder`.
  - `CategoryPicker` (mock `@/lib/api/categories` `fetchTree`): opening the select shows "No category" first, then options indented (`style.paddingLeft` grows with depth) and hidden categories suffixed " (hidden)"; choosing "UI clicks" calls `onChange('ui-clicks')`; choosing "No category" calls `onChange(null)`; while the tree loads the trigger is disabled. (Open the Radix select the same way the existing `asset-filters.test.tsx` opens `KindSelect`.)
  - `asset-filters.test.tsx`: the "isn't supported by the API yet" text is gone; with `categoryId` set, the Filters button reads "Filters (1)"; choosing a category calls `onChange` with `categoryId`.
- [ ] **Step 2: Run** `npx vitest run lib/categories components/categories components/assets/asset-filters.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement**

```ts
// lib/categories/tree-helpers.ts
export function flattenWithDepth(nodes: Category[], depth = 0): Array<Category & { depth: number }> {
  return buildTree(nodes).flatMap((node) => [
    { ...node, depth },
    ...flattenWithDepth(node.children ?? [], depth + 1),
  ]);
}
```

```tsx
// components/categories/category-picker.tsx
'use client';

import { useQuery } from '@tanstack/react-query';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { fetchTree } from '@/lib/api/categories';
import { flattenWithDepth } from '@/lib/categories/tree-helpers';

/** Radix Select forbids an empty value, so "no category" needs a sentinel. */
const NONE = '__none__';

export function CategoryPicker({
  kind,
  value,
  onChange,
  label = 'Category',
  noneLabel = 'No category',
  className,
}: {
  kind: string;
  value: string | null;
  onChange: (categoryId: string | null) => void;
  label?: string;
  noneLabel?: string;
  className?: string;
}) {
  const query = useQuery({ queryKey: ['categories', kind], queryFn: () => fetchTree(kind) });
  const options = flattenWithDepth(query.data ?? []);

  return (
    <Select value={value ?? NONE} onValueChange={(v) => onChange(v === NONE ? null : v)} disabled={query.isLoading}>
      <SelectTrigger aria-label={label} className={className}>
        <SelectValue placeholder={noneLabel} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{noneLabel}</SelectItem>
        {options.map((c) => (
          <SelectItem key={c.id} value={c.id}>
            <span style={{ paddingLeft: c.depth * 12 }}>
              {c.name}
              {c.isActive ? '' : ' (hidden)'}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
```

  In `asset-filters.tsx`: delete `UnsupportedCategoryNotice`; in `FilterFields`' second row add `<CategoryPicker kind={filters.kind ?? 'audio'} value={filters.categoryId ?? null} onChange={(categoryId) => onChange({ ...filters, categoryId: categoryId ?? undefined })} label="Category" noneLabel="All categories" className="md:w-48" />`; `activeCount` includes `filters.categoryId`.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `git add -A lib/categories components/categories components/assets && git commit -m "feat: category picker; the asset list filters by category"`

---

### Task 10: Category for an upload batch (dashboard)

**Files:**
- Modify: `components/upload/upload-drawer.tsx` (a `CategoryPicker` under the kind select; state `categoryId`), `lib/upload/reducer.ts` (`QueueItem.categoryId?: string`; `addFiles(files, kind, extensions, categoryId?)`), `lib/upload/orchestrator.ts` (passes `categoryId` into meta), `lib/upload/queue.ts` (`UploadMeta.categoryId?`; ticket body includes it when set)
- Test: `lib/upload/queue.test.ts`, `lib/upload/reducer.test.ts`, `components/upload/upload-drawer.test.tsx`

- [ ] **Step 1: Failing tests** — queue: `uploadFile(file, { kind, title, categoryId: 'c1' })` puts `categoryId: 'c1'` in the ticket body, and omits the key when undefined; reducer: `addFiles([...], 'audio', exts, 'c1')` stamps every item with `categoryId: 'c1'`; drawer: choosing a category then dropping a file and clicking Upload sends `categoryId` on the ticket (mock `fetchTree`).
- [ ] **Step 2: Run** `npx vitest run lib/upload components/upload` — Expected: FAIL.
- [ ] **Step 3: Implement** — the picker label is "Category for these uploads", `noneLabel` "No category"; the chosen category applies to files added after the choice (stamped at add time, so changing the picker never silently re-files queued items).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "feat: choose a category for an upload batch"`

---

### Task 11: Cover upload helper and real artwork (dashboard)

**Files:**
- Modify: `lib/upload/queue.ts` (export `putToStorage(ticket, file)` — the existing PUT + error mapping, reused by covers)
- Create: `lib/upload/cover.ts`, `lib/upload/cover.test.ts`
- Modify: `components/assets/artwork.tsx` (optional `src`), `components/assets/asset-table.tsx`, `components/assets/asset-card.tsx` (pass `asset.coverUrl`)
- Test: `components/assets/artwork.test.tsx` (new)

**Interfaces:**
- Produces: `uploadCover(assetId: string, file: File): Promise<void>` (ticket `{ role:'thumbnail', assetId, filename, mimeType, byteSize }` → PUT → finalize); `declaredImageMime(file)` (`.jpg/.jpeg`→`image/jpeg`, `.png`→`image/png`, `.webp`→`image/webp`, else `file.type`); `<Artwork id size src? />`.

- [ ] **Step 1: Failing tests** — cover.test (fetch stubs like `queue.test.ts`): runs ticket → PUT (ticket headers, no Authorization) → finalize in order with the ticket body above; a refused finalize rejects with the server's message; a storage CORS failure rejects with the "Couldn't reach file storage…" message and never finalizes. artwork.test: with `src` renders an `img` with that `src` and empty `alt`; without, the gradient `div` and no `img`.
- [ ] **Step 2: Run** `npx vitest run lib/upload components/assets/artwork.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement** — `cover.ts` mirrors `uploadFile`'s ticket/finalize calls (`withRefresh(() => apiFetch(...))`) and calls `putToStorage`. `Artwork`: when `src` is set render `<img src={src} alt="" width={size} height={size} className="shrink-0 rounded-md object-cover" style={{ width: size, height: size }} />` (if eslint's `@next/next/no-img-element` flags it, use `next/image` with `unoptimized` instead — both avoid image-domain config); otherwise the existing gradient. Table and card pass `src={asset.coverUrl ?? undefined}`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git add -A lib/upload components/assets && git commit -m "feat: cover upload helper; asset rows show covers"`

---

### Task 12: Sound page (dashboard)

**Files:**
- Create: `app/(dashboard)/assets/[id]/page.tsx`
- Create: `components/assets/asset-detail-content.tsx`, `components/assets/asset-detail-skeleton.tsx`, `components/assets/asset-edit-form.tsx`, `components/assets/cover-panel.tsx`
- Create: `components/assets/asset-detail-content.test.tsx`, `components/assets/cover-panel.test.tsx`
- Modify: `components/assets/asset-table.tsx`, `components/assets/asset-card.tsx` (title links to `/assets/<id>`)

**Interfaces:**
- Consumes: `fetchAsset`, `updateAsset`, `removeCover` (Task 8); `CategoryPicker` (Task 9); `uploadCover` (Task 11); `useAssetActions().runAction` for publish/unpublish.

- [ ] **Step 1: Failing tests**
  - detail content (mock `@/lib/api/assets`, `@/lib/api/categories`, `next/navigation`): shows a skeleton (`role="status"` named "Loading sound") while loading, never "Loading…" text; shows title, author, status pill, duration and size; "This sound does not exist" on 404; editing the title and choosing a category then Save calls `updateAsset('a1', { title, authorName, categoryId })` and toasts "Sound saved."; Save is disabled until something changed; Publish shows for `ready`, Unpublish for `published`.
  - cover panel: with no cover shows the gradient and "Add cover"; choosing a file calls `uploadCover('a1', file)` and refetches the asset; with a cover shows the image, "Replace" and "Remove"; Remove calls `removeCover('a1')`; an upload error is shown inline (role="alert") with the server's message; the file input accepts `image/jpeg,image/png,image/webp`.
  - table/card: the title is a link to `/assets/a1`.
- [ ] **Step 2: Run** `npx vitest run components/assets` — Expected: FAIL.
- [ ] **Step 3: Implement** — follow the user page: `page.tsx` reads `useParams<{ id: string }>()` and wraps `AssetDetailContent` in `Suspense` with `AssetDetailSkeleton`; the content uses `useQuery({ queryKey: ['assets', 'detail', id], queryFn: () => fetchAsset(id) })`, a "Back to assets" link, a header card (cover via `CoverPanel`, title, status pill, duration via `formatDuration`, size via a `formatBytes` helper in `components/assets/format.ts` with a test), `AssetEditForm` (title `Input`, author `Input`, `CategoryPicker` with `kind={asset.kind}`, Save via `useMutation` → `updateAsset`, on success `invalidateQueries(['assets'])` and toast), and Publish/Unpublish buttons via `useAssetActions`. `CoverPanel` uses `useMutation` for upload and remove, invalidates `['assets']` on settle, shows the error inline, 44px targets below md. Skeleton matches the layout (header card with a square, two lines, a pill; the form's three fields).
- [ ] **Step 4: Run** `npx vitest run components/assets` — Expected: PASS.
- [ ] **Step 5: Dashboard gate** — `npx tsc --noEmit && npx eslint . && npx vitest run` — Expected: all green; test count only grows from 503.
- [ ] **Step 6: Commit** `git add -A app components && git commit -m "feat: sound page with edit, category and cover"`

---

## Final

- Whole-branch review of both repos (`git diff feat/r2-storage...feat/sound-library`) by a fresh reviewer on the most capable model, with the Review Focus list above.
- Fix Critical/Important with a failing test first; re-run both full suites.
- Report to the owner: what to set up (create the `sound-effects` category, R2 CORS unchanged), the contract doc path for the app developer, and that nothing was pushed.
