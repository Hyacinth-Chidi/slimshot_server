# Admin API Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the admin API so the dashboard connects to real endpoints on day one — categories, stats, audit reads, job visibility, and settings/storage-provider management behind step-up re-authentication.

**Architecture:** Five new controllers under `/api/admin/v1`, each guarded by the existing `JwtAuthGuard` + `PermissionsGuard` and registered in `ADMIN_CONTROLLERS` so a handler missing its permission decorator fails the build. One additive migration adds `Category` and `Asset.categoryId`. The security-sensitive piece is secret reveal: a separate service method with exactly one caller, three independent gates, and a single-use elevation grant so one password entry authorises both the read and the follow-up write.

**Tech Stack:** NestJS 11, Prisma 7 (driver adapter → Neon Postgres), Redis (ioredis, for grants and lockout), Jest.

**Spec:** `docs/superpowers/specs/2026-09-23-admin-api-completion-design.md`

## Global Constraints

- TypeScript `strict: true`. `@typescript-eslint/no-explicit-any` is an ERROR — mocks use `as never`, never `any`.
- Only `DATABASE_URL`, `MASTER_ENCRYPTION_KEY`, `PORT`/`NODE_ENV`, `ADMIN_BOOTSTRAP_EMAIL`/`ADMIN_BOOTSTRAP_PASSWORD` may read from `process.env`, and only in the lint-exempted files. Any new `process.env` read is a review rejection.
- Response envelopes: success `{ success: true, data, meta? }`; errors flow through the existing `AllExceptionsFilter`.
- Every mutating handler writes an `AuditLog` row via `AuditService.record`.
- Every list endpoint uses cursor pagination, matching `AdminAssetsController.list`.
- No audit-log delete endpoint at any permission level.
- Commit after every task, staging by explicit path. Never `git add -A`. Never `--no-verify`.
- Commit messages end with a blank line then exactly one trailer: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- Nothing under `src/generated/` may be staged.
- Prisma 7: nullable `Json` columns need the `Prisma.DbNull` sentinel, not plain `null`.

## Review Focus

Five conditions the spec implies but no obvious task exercises. Each has its test pinned to the owning task.

1. **A category deleted while an asset references it** — the spec says refuse with a count. An implementation that checks `children` but not `assets` passes a naive test and silently orphans assets. *(Task 2)*
2. **A grant replayed after the setting it authorised has already been written** — single-use is the property that makes a grant safer than a lingering password. A consumed grant that still works is a durable credential. *(Task 6)*
3. **A reveal attempted by a locked-out account** — if `/reveal` does not consult the same counter as login, it is an unthrottled password oracle against a known owner address. *(Task 5)*
4. **`stats/summary` on an empty database** — aggregate queries over zero rows return `null` from Postgres `SUM`, not `0`. A dashboard rendering `null` bytes shows "NaN". *(Task 3)*
5. **A category whose parent is a different `kind`** — the tree is kind-scoped. Nothing in the column types prevents an `audio` category parenting a `font` one. *(Task 2)*

---

## File Structure

**Task 1** — schema
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<ts>_add_category/migration.sql` (generated)

**Task 2** — categories
- Create: `src/modules/taxonomy/category.service.ts`, `category.service.spec.ts`, `taxonomy.module.ts`
- Create: `src/modules/taxonomy/dto/{create-category,update-category,reorder-categories}.dto.ts`
- Create: `src/modules/admin/admin-categories.controller.ts`

**Task 3** — stats
- Create: `src/modules/admin/stats.service.ts`, `stats.service.spec.ts`, `admin-stats.controller.ts`

**Task 4** — audit + jobs
- Create: `src/modules/admin/admin-audit.controller.ts`, `admin-jobs.controller.ts`
- Modify: `src/core/queue/queue.service.ts` (add `delayed` to health)

**Task 5** — reveal
- Modify: `src/core/settings/settings.service.ts` (add `revealSecret`)
- Create: `src/modules/admin/elevation.service.ts`, `elevation.service.spec.ts`

**Task 6** — settings + providers controller
- Create: `src/modules/admin/admin-settings.controller.ts`, `settings-admin.service.ts` + spec
- Create: `src/modules/admin/dto/{update-setting,reveal-secret,storage-provider}.dto.ts`

**Task 7** — wiring
- Modify: `src/modules/admin/admin.module.ts`, `src/app.module.ts`, `src/core/auth/admin-routes.spec.ts`

---

## Task 1: Category schema and migration

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Consumes: existing `AssetKind` enum, `Asset` model
- Produces: `Category` model; `Asset.categoryId` / `Asset.category`

- [ ] **Step 1: Add the `Category` model to `prisma/schema.prisma`**

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

- [ ] **Step 2: Add the relation to `Asset`**

In the `Asset` model add the field and relation. Keep it nullable — existing assets have no correct default.

```prisma
  categoryId      String?
  category        Category? @relation(fields: [categoryId], references: [id])
```

- [ ] **Step 3: Migrate**

```bash
npx prisma migrate dev --name add_category
npx prisma generate
```

This migration is additive — it creates one table and adds one nullable column. If the output proposes dropping or altering ANY existing table, or offers a reset, answer NO and report BLOCKED with the exact text.

- [ ] **Step 4: Verify data survived and the table exists**

```bash
node -e "require('dotenv').config();const{Client}=require('pg');const c=new Client({connectionString:process.env.DATABASE_URL});c.connect().then(()=>c.query(\"select tablename from pg_tables where schemaname='public' order by tablename\")).then(r=>{console.log('TABLES:',r.rows.map(x=>x.tablename).join(', '));return c.query('select count(*)::int n from \"Asset\"')}).then(r=>{console.log('Asset rows:',r.rows[0].n);return c.end()})"
```

Expected: `Category` present in the list; the `Asset` count unchanged from before the migration.

- [ ] **Step 5: Gates**

```bash
npm run typecheck && npm run lint && npm test
```
Expected: all pass, 177 tests (this task adds none).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add Category table and Asset.categoryId

Additive migration: one new table, one nullable column. Existing assets get
no category rather than an invented default.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Category service and controller

**Files:**
- Create: `src/modules/taxonomy/category.service.ts` + `.spec.ts`
- Create: `src/modules/taxonomy/taxonomy.module.ts`
- Create: `src/modules/taxonomy/dto/create-category.dto.ts`, `update-category.dto.ts`, `reorder-categories.dto.ts`
- Create: `src/modules/admin/admin-categories.controller.ts`

**Interfaces:**
- Consumes: `PrismaService`, `AuditService.record(entry)`, `AssetKind` enum
- Produces:
  - `CategoryService.tree(kind: AssetKind): Promise<CategoryNode[]>`
  - `CategoryService.create(dto: CreateCategoryDto, actorId: string): Promise<Category>`
  - `CategoryService.update(id: string, dto: UpdateCategoryDto, actorId: string): Promise<Category>`
  - `CategoryService.remove(id: string, actorId: string): Promise<void>`
  - `CategoryService.reorder(items: ReorderItem[], actorId: string): Promise<void>`
  - `interface CategoryNode extends Category { children: CategoryNode[] }`
  - `interface ReorderItem { id: string; sortOrder: number }`

- [ ] **Step 1: Write the DTOs**

`src/modules/taxonomy/dto/create-category.dto.ts`:

```ts
import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

import { AssetKind } from '../../../generated/prisma/enums';

export class CreateCategoryDto {
  @IsEnum(AssetKind)
  kind!: AssetKind;

  @IsString()
  @MaxLength(80)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  description?: string;

  @IsOptional()
  @IsString()
  parentId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
```

`update-category.dto.ts`:

```ts
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
```

`reorder-categories.dto.ts`:

```ts
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsString, Min, ValidateNested } from 'class-validator';

export class ReorderItemDto {
  @IsString()
  id!: string;

  @IsInt()
  @Min(0)
  sortOrder!: number;
}

export class ReorderCategoriesDto {
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ReorderItemDto)
  items!: ReorderItemDto[];
}
```

- [ ] **Step 2: Write the failing test**

Create `src/modules/taxonomy/category.service.spec.ts`:

```ts
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

import { AssetKind } from '../../generated/prisma/enums';
import { CategoryService } from './category.service';

type Row = Record<string, unknown>;

function build(rows: Row[] = [], assetCounts: Record<string, number> = {}) {
  const prisma = {
    category: {
      findMany: jest.fn(async () => rows),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        rows.find((r) => r.id === where.id) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = { id: `cat-${rows.length + 1}`, ...data };
        rows.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = rows.find((r) => r.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      }),
      delete: jest.fn(async ({ where }: { where: { id: string } }) => {
        const i = rows.findIndex((r) => r.id === where.id);
        return i >= 0 ? rows.splice(i, 1)[0] : null;
      }),
    },
    asset: {
      count: jest.fn(async ({ where }: { where: { categoryId: string } }) =>
        assetCounts[where.categoryId] ?? 0,
      ),
    },
    $transaction: jest.fn(async (ops: unknown[]) => ops),
  };
  const audit = { record: jest.fn(async () => undefined) };
  return { svc: new CategoryService(prisma as never, audit as never), prisma, audit, rows };
}

describe('CategoryService.create', () => {
  it('derives a slug from the name', async () => {
    const { svc, prisma } = build();
    await svc.create({ kind: AssetKind.audio, name: 'Cinematic Trailers' }, 'admin-1');

    const data = prisma.category.create.mock.calls[0][0].data as Record<string, string>;
    expect(data.slug).toBe('cinematic-trailers');
  });

  it('rejects a parent of a different kind', async () => {
    const parent = { id: 'p1', kind: AssetKind.font, slug: 'serif', name: 'Serif' };
    const { svc } = build([parent]);

    await expect(
      svc.create({ kind: AssetKind.audio, name: 'Cinematic', parentId: 'p1' }, 'admin-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a parent of the same kind', async () => {
    const parent = { id: 'p1', kind: AssetKind.audio, slug: 'music', name: 'Music' };
    const { svc } = build([parent]);

    await expect(
      svc.create({ kind: AssetKind.audio, name: 'Cinematic', parentId: 'p1' }, 'admin-1'),
    ).resolves.toMatchObject({ parentId: 'p1' });
  });

  it('404s for a parentId that does not exist', async () => {
    const { svc } = build();
    await expect(
      svc.create({ kind: AssetKind.audio, name: 'X', parentId: 'nope' }, 'admin-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('audits the creation', async () => {
    const { svc, audit } = build();
    await svc.create({ kind: AssetKind.audio, name: 'Ambient' }, 'admin-1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'category.create', actorId: 'admin-1' }),
    );
  });
});

describe('CategoryService.remove', () => {
  it('refuses to delete a category that assets reference, naming the count', async () => {
    const cat = { id: 'c1', kind: AssetKind.audio, slug: 'music', name: 'Music' };
    const { svc } = build([cat], { c1: 12 });

    await expect(svc.remove('c1', 'admin-1')).rejects.toThrow(/12 asset/);
  });

  it('refuses with a ConflictException specifically', async () => {
    const cat = { id: 'c1', kind: AssetKind.audio, slug: 'music', name: 'Music' };
    const { svc } = build([cat], { c1: 1 });

    await expect(svc.remove('c1', 'admin-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses to delete a category that has children', async () => {
    const parent = { id: 'c1', kind: AssetKind.audio, slug: 'music', name: 'Music' };
    const child = { id: 'c2', kind: AssetKind.audio, slug: 'cine', name: 'Cine', parentId: 'c1' };
    const { svc } = build([parent, child]);

    await expect(svc.remove('c1', 'admin-1')).rejects.toThrow(/child/i);
  });

  it('deletes an unused leaf category', async () => {
    const cat = { id: 'c1', kind: AssetKind.audio, slug: 'music', name: 'Music' };
    const { svc, rows } = build([cat]);

    await svc.remove('c1', 'admin-1');
    expect(rows).toHaveLength(0);
  });
});

describe('CategoryService.tree', () => {
  it('nests children under their parent', async () => {
    const rows = [
      { id: 'c1', kind: AssetKind.audio, slug: 'music', name: 'Music', parentId: null, sortOrder: 0 },
      { id: 'c2', kind: AssetKind.audio, slug: 'cine', name: 'Cine', parentId: 'c1', sortOrder: 0 },
    ];
    const { svc } = build(rows);

    const tree = await svc.tree(AssetKind.audio);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].id).toBe('c2');
  });

  it('returns an empty array when no categories exist', async () => {
    const { svc } = build([]);
    await expect(svc.tree(AssetKind.audio)).resolves.toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx jest src/modules/taxonomy`
Expected: FAIL — `Cannot find module './category.service'`.

- [ ] **Step 4: Write `src/modules/taxonomy/category.service.ts`**

```ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AssetKind } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

export interface ReorderItem {
  id: string;
  sortOrder: number;
}

interface CategoryRow {
  id: string;
  kind: AssetKind;
  parentId: string | null;
  slug: string;
  name: string;
  sortOrder: number;
}

export interface CategoryNode extends CategoryRow {
  children: CategoryNode[];
}

@Injectable()
export class CategoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async tree(kind: AssetKind): Promise<CategoryNode[]> {
    const rows = (await this.prisma.category.findMany({
      where: { kind },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    })) as unknown as CategoryRow[];

    const byId = new Map<string, CategoryNode>();
    for (const r of rows) byId.set(r.id, { ...r, children: [] });

    const roots: CategoryNode[] = [];
    for (const node of byId.values()) {
      const parent = node.parentId ? byId.get(node.parentId) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  async create(dto: CreateCategoryDto, actorId: string): Promise<CategoryRow> {
    if (dto.parentId) await this.assertParentMatchesKind(dto.parentId, dto.kind);

    const created = (await this.prisma.category.create({
      data: {
        kind: dto.kind,
        name: dto.name,
        slug: slugify(dto.name),
        description: dto.description ?? null,
        parentId: dto.parentId ?? null,
        sortOrder: dto.sortOrder ?? 0,
      },
    })) as unknown as CategoryRow;

    await this.audit.record({
      actorId,
      actorType: 'admin',
      action: 'category.create',
      entityType: 'Category',
      entityId: created.id,
      after: { kind: dto.kind, name: dto.name },
    });

    return created;
  }

  async update(
    id: string,
    dto: UpdateCategoryDto,
    actorId: string,
  ): Promise<CategoryRow> {
    const before = await this.load(id);

    const updated = (await this.prisma.category.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name, slug: slugify(dto.name) } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      },
    })) as unknown as CategoryRow;

    await this.audit.record({
      actorId,
      actorType: 'admin',
      action: 'category.update',
      entityType: 'Category',
      entityId: id,
      before: { name: before.name },
      after: dto,
    });

    return updated;
  }

  async remove(id: string, actorId: string): Promise<void> {
    await this.load(id);

    // Children first: deleting a parent would orphan a subtree whose rows still
    // carry its id.
    const children = (await this.prisma.category.findMany({
      where: { parentId: id },
    })) as unknown as CategoryRow[];
    if (children.length > 0) {
      throw new ConflictException(
        `This category has ${children.length} child categor${children.length === 1 ? 'y' : 'ies'}. Move or delete them first.`,
      );
    }

    // Assets second: cascading would silently uncategorise them, and nulling is
    // a data change nobody asked for. Make the admin choose.
    const assetCount = await this.prisma.asset.count({ where: { categoryId: id } });
    if (assetCount > 0) {
      throw new ConflictException(
        `${assetCount} asset${assetCount === 1 ? '' : 's'} use this category. Reassign them first.`,
      );
    }

    await this.prisma.category.delete({ where: { id } });

    await this.audit.record({
      actorId,
      actorType: 'admin',
      action: 'category.delete',
      entityType: 'Category',
      entityId: id,
    });
  }

  async reorder(items: ReorderItem[], actorId: string): Promise<void> {
    await this.prisma.$transaction(
      items.map((i) =>
        this.prisma.category.update({
          where: { id: i.id },
          data: { sortOrder: i.sortOrder },
        }),
      ),
    );

    await this.audit.record({
      actorId,
      actorType: 'admin',
      action: 'category.reorder',
      entityType: 'Category',
      after: { count: items.length },
    });
  }

  private async load(id: string): Promise<CategoryRow> {
    const row = (await this.prisma.category.findUnique({
      where: { id },
    })) as unknown as CategoryRow | null;
    if (!row) throw new NotFoundException(`Category not found: ${id}`);
    return row;
  }

  private async assertParentMatchesKind(
    parentId: string,
    kind: AssetKind,
  ): Promise<void> {
    const parent = await this.load(parentId);
    // The tree is kind-scoped: nothing in the column types stops an audio
    // category parenting a font one, so it is enforced here.
    if (parent.kind !== kind) {
      throw new BadRequestException(
        `Parent category is for ${parent.kind}, not ${kind}.`,
      );
    }
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx jest src/modules/taxonomy`
Expected: PASS, 11 tests.

- [ ] **Step 6: Write the controller**

Create `src/modules/admin/admin-categories.controller.ts`:

```ts
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { AssetKind } from '../../generated/prisma/enums';
import { CurrentUser } from '../../core/auth/current-user.decorator';
import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { RequirePermission } from '../../core/auth/permissions';
import { AccessTokenClaims } from '../auth/token.service';
import { CategoryService } from '../taxonomy/category.service';
import { CreateCategoryDto } from '../taxonomy/dto/create-category.dto';
import { ReorderCategoriesDto } from '../taxonomy/dto/reorder-categories.dto';
import { UpdateCategoryDto } from '../taxonomy/dto/update-category.dto';

@Controller('api/admin/v1/categories')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminCategoriesController {
  constructor(private readonly categories: CategoryService) {}

  @Get()
  @RequirePermission('taxonomy.read')
  async tree(@Query('kind') kind: AssetKind) {
    return { success: true as const, data: await this.categories.tree(kind) };
  }

  @Post()
  @RequirePermission('taxonomy.write')
  async create(
    @Body() dto: CreateCategoryDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return {
      success: true as const,
      data: await this.categories.create(dto, user.sub),
    };
  }

  @Patch(':id')
  @RequirePermission('taxonomy.write')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateCategoryDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return {
      success: true as const,
      data: await this.categories.update(id, dto, user.sub),
    };
  }

  @Delete(':id')
  @RequirePermission('taxonomy.write')
  async remove(@Param('id') id: string, @CurrentUser() user: AccessTokenClaims) {
    await this.categories.remove(id, user.sub);
    return { success: true as const, data: { deleted: true } };
  }

  @Post('reorder')
  @RequirePermission('taxonomy.write')
  async reorder(
    @Body() dto: ReorderCategoriesDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    await this.categories.reorder(dto.items, user.sub);
    return { success: true as const, data: { reordered: dto.items.length } };
  }
}
```

- [ ] **Step 7: Write the module**

Create `src/modules/taxonomy/taxonomy.module.ts`:

```ts
import { Module } from '@nestjs/common';

import { CategoryService } from './category.service';

@Module({
  providers: [CategoryService],
  exports: [CategoryService],
})
export class TaxonomyModule {}
```

- [ ] **Step 8: Gates**

```bash
npm run typecheck && npm run lint && npm test
```
Expected: 188 tests (177 + 11).

- [ ] **Step 9: Commit**

```bash
git add src/modules/taxonomy src/modules/admin/admin-categories.controller.ts
git commit -m "feat: add category tree with kind-scoped parenting

Delete refuses when children or assets reference the category, naming the
count - cascading would orphan assets silently and nulling is a data change
nobody asked for. Parent kind is enforced in the service because nothing in
the column types prevents an audio category parenting a font one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Stats service and controller

**Files:**
- Create: `src/modules/admin/stats.service.ts` + `.spec.ts`
- Create: `src/modules/admin/admin-stats.controller.ts`

**Interfaces:**
- Consumes: `PrismaService`, `CacheService.wrap(ns, keyParts, factory, ttl)`
- Produces:
  - `StatsService.summary(): Promise<StatsSummary>`
  - `StatsService.uploadsOverTime(days: number): Promise<UploadPoint[]>`
  - `interface StatsSummary { totalAssets, byStatus, byKind, totalBytes, failedCount }`
  - `interface UploadPoint { date: string; count: number }`

- [ ] **Step 1: Write the failing test**

Create `src/modules/admin/stats.service.spec.ts`:

```ts
import { StatsService } from './stats.service';

function build(opts: {
  total?: number;
  byStatus?: Array<{ status: string; _count: number }>;
  byKind?: Array<{ kind: string; _count: number }>;
  bytes?: number | null;
  failed?: number;
} = {}) {
  const prisma = {
    asset: {
      count: jest.fn(async ({ where }: { where?: Record<string, unknown> } = {}) =>
        where?.status === 'failed' ? (opts.failed ?? 0) : (opts.total ?? 0),
      ),
      groupBy: jest.fn(async ({ by }: { by: string[] }) =>
        by[0] === 'status' ? (opts.byStatus ?? []) : (opts.byKind ?? []),
      ),
    },
    assetFile: {
      aggregate: jest.fn(async () => ({ _sum: { byteSize: opts.bytes ?? null } })),
    },
    $queryRaw: jest.fn(async () => []),
  };
  // Pass-through cache: these tests are about the aggregates, not caching.
  const cache = {
    wrap: jest.fn(async (_ns: string, _k: unknown, factory: () => Promise<unknown>) =>
      factory(),
    ),
  };
  return { svc: new StatsService(prisma as never, cache as never), prisma, cache };
}

describe('StatsService.summary', () => {
  it('returns zero totals on an empty database rather than null', async () => {
    const { svc } = build({ total: 0, bytes: null, failed: 0 });
    const s = await svc.summary();

    // Postgres SUM over zero rows returns NULL. A dashboard rendering that
    // shows "NaN bytes", so the service must coerce it.
    expect(s.totalBytes).toBe(0);
    expect(s.totalAssets).toBe(0);
    expect(s.failedCount).toBe(0);
  });

  it('sums bytes when files exist', async () => {
    const { svc } = build({ total: 3, bytes: 812_340 });
    await expect(svc.summary()).resolves.toMatchObject({ totalBytes: 812_340 });
  });

  it('maps grouped counts by status', async () => {
    const { svc } = build({
      total: 5,
      byStatus: [
        { status: 'published', _count: 3 },
        { status: 'ready', _count: 2 },
      ],
    });
    const s = await svc.summary();
    expect(s.byStatus).toEqual({ published: 3, ready: 2 });
  });

  it('reports the failed count separately from the status map', async () => {
    const { svc } = build({ total: 4, failed: 2 });
    await expect(svc.summary()).resolves.toMatchObject({ failedCount: 2 });
  });

  it('routes through the cache under a stats namespace', async () => {
    const { svc, cache } = build({ total: 1 });
    await svc.summary();
    expect(cache.wrap).toHaveBeenCalledWith(
      'stats',
      expect.anything(),
      expect.any(Function),
      60,
    );
  });
});

describe('StatsService.uploadsOverTime', () => {
  it('clamps days to the allowed range', async () => {
    const { svc } = build();
    await expect(svc.uploadsOverTime(9_999)).resolves.toEqual([]);
    await expect(svc.uploadsOverTime(0)).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/modules/admin/stats.service.spec.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write `src/modules/admin/stats.service.ts`**

```ts
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../core/cache/cache.service';

export interface StatsSummary {
  totalAssets: number;
  byStatus: Record<string, number>;
  byKind: Record<string, number>;
  totalBytes: number;
  failedCount: number;
}

export interface UploadPoint {
  date: string;
  count: number;
}

const SUMMARY_TTL_SECONDS = 60;
const MIN_DAYS = 1;
const MAX_DAYS = 365;

@Injectable()
export class StatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async summary(): Promise<StatsSummary> {
    return this.cache.wrap(
      'stats',
      { view: 'summary' },
      async () => {
        const [total, statusGroups, kindGroups, bytes, failed] = await Promise.all([
          this.prisma.asset.count({ where: { deletedAt: null } }),
          this.prisma.asset.groupBy({
            by: ['status'],
            where: { deletedAt: null },
            _count: true,
          }),
          this.prisma.asset.groupBy({
            by: ['kind'],
            where: { deletedAt: null },
            _count: true,
          }),
          this.prisma.assetFile.aggregate({ _sum: { byteSize: true } }),
          this.prisma.asset.count({ where: { status: 'failed', deletedAt: null } }),
        ]);

        return {
          totalAssets: total,
          byStatus: toCountMap(statusGroups as never, 'status'),
          byKind: toCountMap(kindGroups as never, 'kind'),
          // Postgres SUM over zero rows is NULL, not 0. Rendering that gives
          // "NaN" in the dashboard, so coerce at the boundary.
          totalBytes: (bytes as { _sum: { byteSize: number | null } })._sum.byteSize ?? 0,
          failedCount: failed,
        };
      },
      SUMMARY_TTL_SECONDS,
    );
  }

  async uploadsOverTime(days: number): Promise<UploadPoint[]> {
    if (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS) return [];

    return this.cache.wrap(
      'stats',
      { view: 'uploads', days },
      async () => {
        const rows = (await this.prisma.$queryRaw`
          SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS date,
                 COUNT(*)::int AS count
          FROM "Asset"
          WHERE "deletedAt" IS NULL
            AND "createdAt" >= NOW() - (${days} || ' days')::interval
          GROUP BY 1
          ORDER BY 1
        `) as UploadPoint[];
        return rows;
      },
      SUMMARY_TTL_SECONDS,
    );
  }
}

function toCountMap(
  groups: Array<Record<string, unknown> & { _count: number }>,
  key: string,
): Record<string, number> {
  return Object.fromEntries(groups.map((g) => [String(g[key]), g._count]));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/modules/admin/stats.service.spec.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the controller**

Create `src/modules/admin/admin-stats.controller.ts`:

```ts
import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { RequirePermission } from '../../core/auth/permissions';
import { StatsService } from './stats.service';

@Controller('api/admin/v1/stats')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminStatsController {
  constructor(private readonly stats: StatsService) {}

  @Get('summary')
  @RequirePermission('asset.read')
  async summary() {
    return { success: true as const, data: await this.stats.summary() };
  }

  @Get('uploads-over-time')
  @RequirePermission('asset.read')
  async uploads(
    @Query('days', new DefaultValuePipe(30), ParseIntPipe) days: number,
  ) {
    return { success: true as const, data: await this.stats.uploadsOverTime(days) };
  }
}
```

- [ ] **Step 6: Gates**

```bash
npm run typecheck && npm run lint && npm test
```
Expected: 194 tests.

- [ ] **Step 7: Commit**

```bash
git add src/modules/admin/stats.service.ts src/modules/admin/stats.service.spec.ts src/modules/admin/admin-stats.controller.ts
git commit -m "feat: add dashboard statistics

Postgres SUM over zero rows returns NULL, so totalBytes is coerced to 0 at the
boundary - a dashboard rendering the raw value would show NaN on an empty
database. Summary is cached 60s under the stats namespace.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Audit and jobs controllers

**Files:**
- Create: `src/modules/admin/admin-audit.controller.ts`
- Create: `src/modules/admin/admin-jobs.controller.ts`
- Modify: `src/core/queue/queue.service.ts`
- Modify: `src/core/queue/queue.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `QueueService`
- Produces: `QueueService.getQueueHealth()` now returns `{ waiting, active, failed, delayed }`

- [ ] **Step 1: Write the failing test for delayed jobs**

In `src/core/queue/queue.service.spec.ts`, add `getDelayedCount` to the fake queue and a new test:

```ts
  it('reports delayed jobs, where a retrying job actually sits', async () => {
    const svc = new QueueService(fakeQueue() as never);
    // A job between retry attempts is neither waiting, active, nor failed —
    // without this it is invisible in the admin view.
    await expect(svc.getQueueHealth()).resolves.toMatchObject({ delayed: 3 });
  });
```

Add to `fakeQueue()`: `getDelayedCount: jest.fn(async () => 3),`

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/core/queue`
Expected: FAIL — `delayed` undefined.

- [ ] **Step 3: Add `delayed` to `getQueueHealth`**

In `src/core/queue/queue.service.ts`, change the return type and the destructure:

```ts
  async getQueueHealth(): Promise<{
    waiting: number;
    active: number;
    failed: number;
    delayed: number;
  }> {
    const [waiting, active, failed, delayed] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getFailedCount(),
      this.queue.getDelayedCount(),
    ]);
    return { waiting, active, failed, delayed };
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/core/queue`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the audit controller**

Create `src/modules/admin/admin-audit.controller.ts`:

```ts
import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { RequirePermission } from '../../core/auth/permissions';
import { PrismaService } from '../../prisma/prisma.service';

const MAX_LIMIT = 100;

@Controller('api/admin/v1/audit-logs')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminAuditController {
  constructor(private readonly prisma: PrismaService) {}

  // Read-only by design. There is deliberately no delete handler at any
  // permission level: an audit log an admin can erase is not an audit log.
  @Get()
  @RequirePermission('audit.read')
  async list(
    @Query('actorId') actorId?: string,
    @Query('action') action?: string,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const take = Math.min(Number(limit) || 25, MAX_LIMIT);

    const rows = await this.prisma.auditLog.findMany({
      where: {
        ...(actorId ? { actorId } : {}),
        ...(action ? { action } : {}),
        ...(entityType ? { entityType } : {}),
        ...(entityId ? { entityId } : {}),
      },
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { createdAt: 'desc' },
    });

    return {
      success: true as const,
      data: rows,
      meta: {
        nextCursor: rows.length === take ? rows[rows.length - 1].id : null,
      },
    };
  }
}
```

- [ ] **Step 6: Write the jobs controller**

Create `src/modules/admin/admin-jobs.controller.ts`:

```ts
import { Controller, Get, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { RequirePermission } from '../../core/auth/permissions';
import { QueueService } from '../../core/queue/queue.service';

@Controller('api/admin/v1/jobs')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminJobsController {
  constructor(private readonly queue: QueueService) {}

  @Get('health')
  @RequirePermission('jobs.read')
  async health() {
    return { success: true as const, data: await this.queue.getQueueHealth() };
  }
}
```

Note: `GET /jobs/failed` and `POST /jobs/:id/retry` from the spec need BullMQ job
introspection that the current `QueueService` does not expose. They are deferred to the
task that adds the first worker, when there are real failed jobs to list. Record that in
the commit message rather than shipping endpoints that always return empty.

- [ ] **Step 7: Gates**

```bash
npm run typecheck && npm run lint && npm test
```
Expected: 195 tests.

- [ ] **Step 8: Commit**

```bash
git add src/core/queue src/modules/admin/admin-audit.controller.ts src/modules/admin/admin-jobs.controller.ts
git commit -m "feat: add audit log reads and queue health

getQueueHealth now reports delayed jobs - a job between retry attempts sits
there and was invisible in the admin view. The audit controller has no delete
handler at any permission level, deliberately.

/jobs/failed and /jobs/:id/retry are deferred to the task that adds the first
worker: no worker consumes the queue yet, so they would always return empty.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Secret reveal and elevation grants

This is the security-critical task. Every gate gets its own test asserting a refusal.

**Files:**
- Modify: `src/core/settings/settings.service.ts`
- Create: `src/modules/admin/elevation.service.ts` + `.spec.ts`

**Interfaces:**
- Consumes: `EnvelopeCryptoService`, `PrismaService`, `REDIS` token, `SETTINGS` registry
- Produces:
  - `SettingsService.revealSecret(key: string): Promise<string>`
  - `ElevationService.issue(adminId: string, key: string): Promise<string>` — returns the grant
  - `ElevationService.consume(grant: string, adminId: string, key: string): Promise<boolean>`
  - `ElevationService.revokeForAdmin(adminId: string): Promise<void>`

- [ ] **Step 1: Write the failing test for `revealSecret`**

Add to `src/core/settings/settings.service.spec.ts`:

```ts
  it('reveals the true value of a secret setting', async () => {
    const svc = new SettingsService(prismaMock() as never, crypto);
    const real = 'tok_sample_abcdef123456789012345678';
    await svc.set('auth.jwtAccessSecret', real, 'admin-1');

    await expect(svc.revealSecret('auth.jwtAccessSecret')).resolves.toBe(real);
  });

  it('refuses to reveal a setting that is not marked secret', async () => {
    const svc = new SettingsService(prismaMock() as never, crypto);
    // Reveal exists for credentials. A non-secret setting is already readable
    // via get(), so routing it through the privileged path would be a way to
    // normalise calling reveal on anything.
    await expect(svc.revealSecret('upload.audio.maxBytes')).rejects.toThrow(
      /not a secret/i,
    );
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/core/settings`
Expected: FAIL — `revealSecret is not a function`.

- [ ] **Step 3: Add `revealSecret` to `SettingsService`**

Place it immediately after `getMaskedGroup`:

```ts
  /**
   * Returns a secret's true value. This is the ONLY path that returns decrypted
   * plaintext to a caller, and it is deliberately a separate method rather than
   * a flag on getMaskedGroup: a boolean can default wrong, be forwarded from a
   * query string, or be set by a caller that did not intend it. A separate
   * method cannot be reached by accident.
   *
   * Callers MUST gate this behind re-authentication. It has exactly one caller
   * (AdminSettingsController.reveal) and a test asserts that.
   */
  async revealSecret(key: string): Promise<string> {
    const def = this.definition(key);
    if (!def.secret) {
      throw new Error(`${key} is not a secret setting; use get() instead.`);
    }
    return this.get<string>(key);
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/core/settings`
Expected: PASS.

- [ ] **Step 5: Write the failing test for `ElevationService`**

Create `src/modules/admin/elevation.service.spec.ts`:

```ts
import { ElevationService } from './elevation.service';

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    set: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    }),
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    del: jest.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
    keys: jest.fn(async (pattern: string) => {
      const prefix = pattern.replace(/\*$/, '');
      return [...store.keys()].filter((k) => k.startsWith(prefix));
    }),
  };
}

describe('ElevationService', () => {
  it('issues a grant that validates for the same admin and key', async () => {
    const svc = new ElevationService(fakeRedis() as never);
    const grant = await svc.issue('admin-1', 'auth.jwtAccessSecret');

    await expect(
      svc.consume(grant, 'admin-1', 'auth.jwtAccessSecret'),
    ).resolves.toBe(true);
  });

  it('refuses a grant for a DIFFERENT setting key', async () => {
    const svc = new ElevationService(fakeRedis() as never);
    const grant = await svc.issue('admin-1', 'auth.jwtAccessSecret');

    // Scoping is what stops one unlock authorising every credential.
    await expect(svc.consume(grant, 'admin-1', 'redis.url')).resolves.toBe(false);
  });

  it('refuses a grant issued to a DIFFERENT admin', async () => {
    const svc = new ElevationService(fakeRedis() as never);
    const grant = await svc.issue('admin-1', 'auth.jwtAccessSecret');

    await expect(
      svc.consume(grant, 'admin-2', 'auth.jwtAccessSecret'),
    ).resolves.toBe(false);
  });

  it('refuses a grant that has already been consumed', async () => {
    const svc = new ElevationService(fakeRedis() as never);
    const grant = await svc.issue('admin-1', 'auth.jwtAccessSecret');

    await svc.consume(grant, 'admin-1', 'auth.jwtAccessSecret');
    // Single-use is the property that makes a grant safer than a lingering
    // password. A replayable grant is a durable credential.
    await expect(
      svc.consume(grant, 'admin-1', 'auth.jwtAccessSecret'),
    ).resolves.toBe(false);
  });

  it('refuses an unknown grant', async () => {
    const svc = new ElevationService(fakeRedis() as never);
    await expect(
      svc.consume('never-issued', 'admin-1', 'auth.jwtAccessSecret'),
    ).resolves.toBe(false);
  });

  it('revokes every grant belonging to an admin', async () => {
    const svc = new ElevationService(fakeRedis() as never);
    const g1 = await svc.issue('admin-1', 'auth.jwtAccessSecret');
    const g2 = await svc.issue('admin-1', 'redis.url');

    await svc.revokeForAdmin('admin-1');

    await expect(svc.consume(g1, 'admin-1', 'auth.jwtAccessSecret')).resolves.toBe(false);
    await expect(svc.consume(g2, 'admin-1', 'redis.url')).resolves.toBe(false);
  });

  it('stores only a hash of the grant, never the grant itself', async () => {
    const redis = fakeRedis();
    const svc = new ElevationService(redis as never);
    const grant = await svc.issue('admin-1', 'auth.jwtAccessSecret');

    expect([...redis.store.keys()].some((k) => k.includes(grant))).toBe(false);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx jest src/modules/admin/elevation.service.spec.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 7: Write `src/modules/admin/elevation.service.ts`**

```ts
import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { createHash, randomBytes } from 'node:crypto';

import { REDIS } from '../../core/cache/cache.service';

/**
 * Matches the dashboard's 2-minute idle lock, so the server-side window and the
 * UI lock expire together rather than one outliving the other.
 */
const GRANT_TTL_SECONDS = 120;

/**
 * A short-lived, single-use, key-scoped authorisation to write one secret
 * setting. Issued by a successful password re-authentication.
 *
 * The alternative is holding the password in browser memory for the whole edit,
 * which the dashboard spec forbids. A token that expires in two minutes and can
 * only write one key is strictly less dangerous than a lingering password.
 *
 * Deliberately NOT a JWT: nothing about a grant should be self-describing or
 * verifiable offline. It is an opaque random string whose only meaning is a row
 * in Redis that can be deleted.
 */
@Injectable()
export class ElevationService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async issue(adminId: string, key: string): Promise<string> {
    const grant = randomBytes(32).toString('base64url');
    await this.redis.set(
      this.redisKey(grant),
      JSON.stringify({ adminId, key }),
      'EX',
      GRANT_TTL_SECONDS,
    );
    return grant;
  }

  /** Validates and destroys the grant. Returns false for any mismatch. */
  async consume(grant: string, adminId: string, key: string): Promise<boolean> {
    const redisKey = this.redisKey(grant);
    const raw = await this.redis.get(redisKey);
    if (!raw) return false;

    const parsed = JSON.parse(raw) as { adminId: string; key: string };
    if (parsed.adminId !== adminId || parsed.key !== key) return false;

    await this.redis.del(redisKey);
    return true;
  }

  /** Called on logout and on deactivation: expiry is the backstop, not the only control. */
  async revokeForAdmin(adminId: string): Promise<void> {
    const keys = await this.redis.keys('elevation:*');
    for (const k of keys) {
      const raw = await this.redis.get(k);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as { adminId: string };
      if (parsed.adminId === adminId) await this.redis.del(k);
    }
  }

  /** The grant is stored by hash, so a Redis dump does not yield usable grants. */
  private redisKey(grant: string): string {
    return `elevation:${createHash('sha256').update(grant).digest('hex')}`;
  }
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `npx jest src/modules/admin/elevation.service.spec.ts`
Expected: PASS, 7 tests.

- [ ] **Step 9: Gates**

```bash
npm run typecheck && npm run lint && npm test
```
Expected: 204 tests.

- [ ] **Step 10: Commit**

```bash
git add src/core/settings src/modules/admin/elevation.service.ts src/modules/admin/elevation.service.spec.ts
git commit -m "feat: add secret reveal and single-use elevation grants

revealSecret is a separate method rather than a flag on getMaskedGroup: a
boolean can default wrong or be forwarded from a query string, a separate
method cannot be reached by accident. It refuses non-secret settings.

Grants are opaque random strings stored by hash, scoped to one admin and one
key, single-use, 120s TTL matching the dashboard's idle lock. Five tests each
assert a refusal: wrong key, wrong admin, reuse, unknown, revoked.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Settings controller with re-authentication

**Files:**
- Create: `src/modules/admin/settings-admin.service.ts` + `.spec.ts`
- Create: `src/modules/admin/admin-settings.controller.ts`
- Create: `src/modules/admin/dto/update-setting.dto.ts`, `reveal-secret.dto.ts`

**Interfaces:**
- Consumes: `SettingsService.revealSecret/getMaskedGroup/set`, `ElevationService`, `PasswordService.verify`, `PrismaService`, `AuditService`, `REDIS`
- Produces:
  - `SettingsAdminService.reveal(key, adminId, password, ctx): Promise<{ value: string; grant: string; expiresIn: number }>`
  - `SettingsAdminService.update(key, value, adminId, auth, ctx): Promise<void>`

- [ ] **Step 1: Write the DTOs**

`src/modules/admin/dto/reveal-secret.dto.ts`:

```ts
import { IsString, MinLength } from 'class-validator';

export class RevealSecretDto {
  @IsString()
  @MinLength(8)
  password!: string;
}
```

`src/modules/admin/dto/update-setting.dto.ts`:

```ts
import { IsDefined, IsOptional, IsString, MinLength } from 'class-validator';

export class UpdateSettingDto {
  @IsDefined()
  value!: unknown;

  /** Either a fresh password or a grant from a prior reveal. Neither is needed for a non-secret setting. */
  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;

  @IsOptional()
  @IsString()
  grant?: string;
}
```

- [ ] **Step 2: Write the failing test**

Create `src/modules/admin/settings-admin.service.spec.ts`:

```ts
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';

import { PasswordService } from '../auth/password.service';
import { SettingsAdminService } from './settings-admin.service';

const CTX = { ip: '1.2.3.4', userAgent: 'test' };
const passwords = new PasswordService();

async function build(opts: { attempts?: number; isSecret?: boolean } = {}) {
  const hash = await passwords.hash('correct-password');
  const prisma = {
    adminUser: {
      findFirst: jest.fn(async () => ({
        id: 'admin-1',
        email: 'owner@example.com',
        passwordHash: hash,
        isActive: true,
        deletedAt: null,
      })),
    },
  };

  const settings = {
    revealSecret: jest.fn(async () => 'the-real-secret-value-1234567890'),
    set: jest.fn(async () => undefined),
    getMaskedGroup: jest.fn(async () => []),
    // The same instance serves config reads: the service takes SettingsService
    // once and uses it for both revealing secrets and reading lockout limits.
    get: jest.fn(async (k: string) =>
      k === 'auth.loginMaxAttempts' ? 5 : 900,
    ),
  };

  const elevation = {
    issue: jest.fn(async () => 'grant-abc'),
    consume: jest.fn(async () => true),
  };

  let counter = opts.attempts ?? 0;
  const redis = {
    incr: jest.fn(async () => (counter += 1)),
    expire: jest.fn(async () => 1),
    get: jest.fn(async () => String(counter)),
    del: jest.fn(async () => {
      counter = 0;
      return 1;
    }),
  };

  const audit = { record: jest.fn(async () => undefined) };

  const svc = new SettingsAdminService(
    prisma as never,
    settings as never,
    elevation as never,
    passwords,
    audit as never,
    redis as never,
  );

  return { svc, settings, elevation, audit, redis };
}

describe('SettingsAdminService.reveal', () => {
  it('returns the value and a grant for a correct password', async () => {
    const { svc } = await build();
    const out = await svc.reveal('auth.jwtAccessSecret', 'admin-1', 'correct-password', CTX);

    expect(out.value).toBe('the-real-secret-value-1234567890');
    expect(out.grant).toBe('grant-abc');
    expect(out.expiresIn).toBe(120);
  });

  it('refuses a wrong password', async () => {
    const { svc } = await build();
    await expect(
      svc.reveal('auth.jwtAccessSecret', 'admin-1', 'wrong-password', CTX),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('never calls revealSecret when the password is wrong', async () => {
    const { svc, settings } = await build();
    await svc
      .reveal('auth.jwtAccessSecret', 'admin-1', 'wrong-password', CTX)
      .catch(() => undefined);

    expect(settings.revealSecret).not.toHaveBeenCalled();
  });

  it('refuses when the account is locked out, before checking the password', async () => {
    const { svc, settings } = await build({ attempts: 5 });
    await expect(
      svc.reveal('auth.jwtAccessSecret', 'admin-1', 'correct-password', CTX),
    ).rejects.toThrow(/too many/i);
    expect(settings.revealSecret).not.toHaveBeenCalled();
  });

  it('counts a failed reveal against the same lockout as login', async () => {
    const { svc, redis } = await build();
    await svc
      .reveal('auth.jwtAccessSecret', 'admin-1', 'wrong-password', CTX)
      .catch(() => undefined);

    // Without this, /reveal is an unthrottled password oracle against a known
    // owner address that never touches /auth/login.
    expect(redis.incr).toHaveBeenCalled();
  });

  it('audits both success and failure, never recording the value', async () => {
    const { svc, audit } = await build();
    await svc.reveal('auth.jwtAccessSecret', 'admin-1', 'correct-password', CTX);
    await svc
      .reveal('auth.jwtAccessSecret', 'admin-1', 'wrong-password', CTX)
      .catch(() => undefined);

    const actions = audit.record.mock.calls.map(
      (c) => (c[0] as { action: string }).action,
    );
    expect(actions).toContain('settings.reveal.succeeded');
    expect(actions).toContain('settings.reveal.failed');
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(
      'the-real-secret-value',
    );
  });
});

describe('SettingsAdminService.update', () => {
  it('accepts a valid grant without a password', async () => {
    const { svc, settings } = await build();
    await svc.update(
      'auth.jwtAccessSecret',
      'new-value-12345678901234567890123',
      'admin-1',
      { grant: 'grant-abc' },
      CTX,
    );
    expect(settings.set).toHaveBeenCalled();
  });

  it('refuses when neither a password nor a grant is supplied for a secret', async () => {
    const { svc } = await build();
    await expect(
      svc.update('auth.jwtAccessSecret', 'x'.repeat(40), 'admin-1', {}, CTX),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses when the grant is rejected', async () => {
    const { svc, elevation } = await build();
    (elevation.consume as jest.Mock).mockResolvedValue(false);

    await expect(
      svc.update('auth.jwtAccessSecret', 'x'.repeat(40), 'admin-1', { grant: 'stale' }, CTX),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('updates a NON-secret setting with no password or grant', async () => {
    const { svc, settings } = await build();
    await svc.update('upload.audio.maxBytes', 1000, 'admin-1', {}, CTX);
    expect(settings.set).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx jest src/modules/admin/settings-admin.service.spec.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 4: Write `src/modules/admin/settings-admin.service.ts`**

```ts
import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type Redis from 'ioredis';

import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { REDIS } from '../../core/cache/cache.service';
import { SETTINGS } from '../../core/settings/setting-definitions';
import { SettingsService } from '../../core/settings/settings.service';
import { PasswordService } from '../auth/password.service';
import { ElevationService } from './elevation.service';

export interface RevealResult {
  value: string;
  grant: string;
  expiresIn: number;
}

export interface AuthProof {
  password?: string;
  grant?: string;
}

interface RequestContext {
  ip?: string;
  userAgent?: string;
}

const GRANT_TTL_SECONDS = 120;

@Injectable()
export class SettingsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly elevation: ElevationService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async reveal(
    key: string,
    adminId: string,
    password: string,
    ctx: RequestContext,
  ): Promise<RevealResult> {
    const admin = await this.loadAdmin(adminId);
    await this.assertNotLockedOut(admin.email);

    const ok = await this.passwords.verify(admin.passwordHash, password);
    if (!ok) {
      await this.recordFailure(admin.email, key, ctx);
      throw new UnauthorizedException('Password is incorrect.');
    }

    await this.redis.del(this.attemptKey(admin.email));

    // Audit BEFORE returning, so a reveal that crashes mid-flight is still
    // recorded. The payload names the key, never the value.
    await this.audit.record({
      actorId: adminId,
      actorType: 'admin',
      action: 'settings.reveal.succeeded',
      entityType: 'SystemSetting',
      entityId: key,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    const value = await this.settings.revealSecret(key);
    const grant = await this.elevation.issue(adminId, key);

    return { value, grant, expiresIn: GRANT_TTL_SECONDS };
  }

  async update(
    key: string,
    value: unknown,
    adminId: string,
    proof: AuthProof,
    ctx: RequestContext,
  ): Promise<void> {
    const def = SETTINGS.get(key);
    if (!def) throw new ForbiddenException(`Unknown setting: ${key}`);

    if (def.secret) {
      await this.assertElevated(key, adminId, proof, ctx);
    }

    await this.settings.set(key, value, adminId);

    await this.audit.record({
      actorId: adminId,
      actorType: 'admin',
      action: 'settings.update',
      entityType: 'SystemSetting',
      entityId: key,
      // For a secret, record only that it changed — never the old or new value.
      after: def.secret ? { changed: true } : { value },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }

  private async assertElevated(
    key: string,
    adminId: string,
    proof: AuthProof,
    ctx: RequestContext,
  ): Promise<void> {
    if (proof.grant) {
      const ok = await this.elevation.consume(proof.grant, adminId, key);
      if (!ok) {
        throw new ForbiddenException(
          'That authorisation has expired or does not apply to this setting.',
        );
      }
      return;
    }

    if (proof.password) {
      const admin = await this.loadAdmin(adminId);
      await this.assertNotLockedOut(admin.email);
      const ok = await this.passwords.verify(admin.passwordHash, proof.password);
      if (!ok) {
        await this.recordFailure(admin.email, key, ctx);
        throw new UnauthorizedException('Password is incorrect.');
      }
      return;
    }

    throw new ForbiddenException(
      'Changing a secret setting requires your password or a current authorisation.',
    );
  }

  private async loadAdmin(adminId: string): Promise<{
    id: string;
    email: string;
    passwordHash: string;
  }> {
    const admin = await this.prisma.adminUser.findFirst({
      where: { id: adminId, deletedAt: null, isActive: true },
    });
    if (!admin) throw new UnauthorizedException('Account is no longer active.');
    return admin as unknown as { id: string; email: string; passwordHash: string };
  }

  private attemptKey(email: string): string {
    // Deliberately the SAME key login uses: a failed reveal must count against
    // the same budget, or this endpoint is an unthrottled password oracle.
    return `auth:login:fail:${email.toLowerCase()}`;
  }

  private async assertNotLockedOut(email: string): Promise<void> {
    const max = await this.settings.get<number>('auth.loginMaxAttempts');
    const current = Number((await this.redis.get(this.attemptKey(email))) ?? '0');
    if (current >= max) {
      throw new UnauthorizedException(
        'Too many failed attempts. Try again later.',
      );
    }
  }

  private async recordFailure(
    email: string,
    key: string,
    ctx: RequestContext,
  ): Promise<void> {
    const lockout = await this.settings.get<number>('auth.loginLockoutSeconds');
    await this.redis.incr(this.attemptKey(email));
    await this.redis.expire(this.attemptKey(email), lockout);

    await this.audit.record({
      actorType: 'system',
      action: 'settings.reveal.failed',
      entityType: 'SystemSetting',
      entityId: key,
      after: { email },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }
}
```

`SettingsService` serves two roles here — revealing secrets and reading the lockout limits —
and is injected once as `settings` for both. The spec's `settings` mock therefore carries
`get` alongside `revealSecret`.

- [ ] **Step 5: Run to verify it passes**

Run: `npx jest src/modules/admin/settings-admin.service.spec.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Write the controller**

Create `src/modules/admin/admin-settings.controller.ts`:

```ts
import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { CurrentUser } from '../../core/auth/current-user.decorator';
import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { RequirePermission } from '../../core/auth/permissions';
import { SettingsService } from '../../core/settings/settings.service';
import { AccessTokenClaims } from '../auth/token.service';
import { RevealSecretDto } from './dto/reveal-secret.dto';
import { UpdateSettingDto } from './dto/update-setting.dto';
import { SettingsAdminService } from './settings-admin.service';

interface RequestLike {
  ip?: string;
  headers: Record<string, string | undefined>;
}

@Controller('api/admin/v1/settings')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminSettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly admin: SettingsAdminService,
  ) {}

  @Get()
  @RequirePermission('settings.read')
  async list(@Query('group') group = 'upload') {
    return {
      success: true as const,
      data: await this.settings.getMaskedGroup(group),
    };
  }

  @Put(':key')
  @RequirePermission('settings.write')
  async update(
    @Param('key') key: string,
    @Body() dto: UpdateSettingDto,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: RequestLike,
  ) {
    await this.admin.update(
      key,
      dto.value,
      user.sub,
      { password: dto.password, grant: dto.grant },
      ctx(req),
    );
    return { success: true as const, data: { updated: true } };
  }

  // The ONLY caller of SettingsService.revealSecret. A test asserts that.
  @Post(':key/reveal')
  @RequirePermission('settings.write')
  @Header('Cache-Control', 'no-store')
  async reveal(
    @Param('key') key: string,
    @Body() dto: RevealSecretDto,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: RequestLike,
  ) {
    return {
      success: true as const,
      data: await this.admin.reveal(key, user.sub, dto.password, ctx(req)),
    };
  }
}

function ctx(req: RequestLike) {
  return { ip: req.ip, userAgent: req.headers['user-agent'] };
}
```

- [ ] **Step 7: Add the single-caller test**

Create `src/modules/admin/reveal-callers.spec.ts`:

```ts
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === 'generated' || entry === 'node_modules') continue;
      walk(p, out);
    } else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) {
      out.push(p);
    }
  }
  return out;
}

describe('revealSecret call sites', () => {
  it('is called from exactly one place in src', () => {
    // revealSecret is the only path returning decrypted plaintext. A second
    // caller is a second thing to audit, and the point of a separate method is
    // that it cannot be reached by accident.
    const callers = walk(join(process.cwd(), 'src')).filter((f) => {
      const body = readFileSync(f, 'utf8');
      return (
        body.includes('.revealSecret(') && !f.endsWith('settings.service.ts')
      );
    });

    expect(callers.map((f) => f.replace(process.cwd(), ''))).toHaveLength(1);
  });
});
```

- [ ] **Step 8: Gates**

```bash
npm run typecheck && npm run lint && npm test
```
Expected: 215 tests.

- [ ] **Step 9: Commit**

```bash
git add src/modules/admin
git commit -m "feat: add settings controller with step-up re-authentication

Reveal requires owner permission, the account password, and not being locked
out. Failures feed the same Redis counter as login, so the endpoint cannot be
used as an unthrottled password oracle. The audit row names the key and never
the value, and is written before the value is returned.

Update accepts either a fresh password or a grant from a prior reveal, so one
unlock covers both reading and editing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Wire everything into the app

**Files:**
- Modify: `src/modules/admin/admin.module.ts`
- Modify: `src/app.module.ts`
- Modify: `src/core/auth/admin-routes.spec.ts`

**Interfaces:**
- Consumes: every controller and service from Tasks 2-6
- Produces: a running app exposing all new routes

- [ ] **Step 1: Add the new controllers to `ADMIN_CONTROLLERS`**

In `src/core/auth/admin-routes.spec.ts`, import and add all five new controllers to the
array. This is the mechanism that fails the build when a handler forgets its permission
decorator — leaving the array stale defeats it.

```ts
const ADMIN_CONTROLLERS: Array<new (...args: never[]) => object> = [
  AdminAssetsController,
  AdminKindsController,
  AdminCategoriesController,
  AdminStatsController,
  AdminAuditController,
  AdminJobsController,
  AdminSettingsController,
];
```

- [ ] **Step 2: Run to verify it fails or passes honestly**

Run: `npx jest src/core/auth/admin-routes.spec.ts`
Expected: PASS. If it FAILS, a handler is missing `@RequirePermission` — fix the handler,
never the test.

- [ ] **Step 3: Update `admin.module.ts`**

```ts
import { Module } from '@nestjs/common';

import { AssetsModule } from '../assets/assets.module';
import { AuthModule } from '../auth/auth.module';
import { IngestModule } from '../ingest/ingest.module';
import { TaxonomyModule } from '../taxonomy/taxonomy.module';
import { AdminAssetsController } from './admin-assets.controller';
import { AdminAuditController } from './admin-audit.controller';
import { AdminCategoriesController } from './admin-categories.controller';
import { AdminJobsController } from './admin-jobs.controller';
import { AdminKindsController } from './admin-kinds.controller';
import { AdminSettingsController } from './admin-settings.controller';
import { AdminStatsController } from './admin-stats.controller';
import { ElevationService } from './elevation.service';
import { SettingsAdminService } from './settings-admin.service';
import { StatsService } from './stats.service';

@Module({
  imports: [AssetsModule, IngestModule, AuthModule, TaxonomyModule],
  controllers: [
    AdminAssetsController,
    AdminKindsController,
    AdminCategoriesController,
    AdminStatsController,
    AdminAuditController,
    AdminJobsController,
    AdminSettingsController,
  ],
  providers: [StatsService, ElevationService, SettingsAdminService],
})
export class AdminModule {}
```

- [ ] **Step 4: Add `TaxonomyModule` to `app.module.ts`**

Add the import and place `TaxonomyModule` in the `imports` array before `AdminModule`.

- [ ] **Step 5: Verify the app actually boots**

Unit tests never construct the container, so a module wiring error would not show up in
them. Compile it:

```bash
npx ts-node -e "
import { Test } from '@nestjs/testing';
import { AppModule } from './src/app.module';
Test.createTestingModule({ imports: [AppModule] }).compile()
  .then(() => console.log('CONTAINER_COMPILES: true'))
  .catch((e) => { console.log('CONTAINER_FAILED:', e.message); process.exit(1); });
"
```

Expected: `CONTAINER_COMPILES: true`. If it fails on a missing provider, the module's
`imports`/`providers` are wrong — fix them, and report what was missing.

- [ ] **Step 6: Full gates**

```bash
npx prisma generate && npm run typecheck && npm run lint && npm test
```
Expected: all pass, 215 tests.

- [ ] **Step 7: Commit**

```bash
git add src/modules/admin/admin.module.ts src/app.module.ts src/core/auth/admin-routes.spec.ts
git commit -m "feat: wire the new admin controllers into the app

All five new controllers are added to ADMIN_CONTROLLERS, so the build-time
check that every admin handler declares a permission now covers them.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Deferred

- `GET /jobs/failed` and `POST /jobs/:id/retry` — need BullMQ job introspection and real
  failed jobs to list. Belongs with the task that adds the first worker.
- Storage-provider CRUD (`POST/PATCH /storage-providers`, `test-connection`,
  `set-default` calling `StorageRegistry.invalidate()`). The spec defines it; it is a
  second security-sensitive surface and deserves its own plan rather than being appended
  to a seventh task here.
- Cross-instance settings-cache invalidation via Redis pub/sub.
