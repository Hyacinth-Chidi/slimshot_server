import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

import { AssetKind } from '../../generated/prisma/enums';
import { CategoryService } from './category.service';

type Row = Record<string, unknown>;

function build(rows: Row[] = [], assetCounts: Record<string, number> = {}) {
  const prisma = {
    category: {
      findMany: jest.fn(async ({ where }: { where?: Record<string, unknown> } = {}) =>
        rows.filter((r) =>
          where?.parentId !== undefined ? r.parentId === where.parentId : true,
        ),
      ),
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

  it('does not treat another parent\'s child as its own', async () => {
    const target = { id: 'c1', kind: AssetKind.audio, slug: 'music', name: 'Music', parentId: null };
    const stranger = { id: 'c9', kind: AssetKind.audio, slug: 'other', name: 'Other', parentId: 'somebody-else' };
    const { svc, rows } = build([target, stranger]);

    // c1 has no children of its own; a child of a DIFFERENT parent must not block it.
    await svc.remove('c1', 'admin-1');
    expect(rows.map((r) => r.id)).toEqual(['c9']);
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
