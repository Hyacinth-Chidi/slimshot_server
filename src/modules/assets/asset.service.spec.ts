import { BadRequestException, NotFoundException } from '@nestjs/common';

import { AssetKind, AssetStatus, FileRole } from '../../generated/prisma/enums';
import { AssetService } from './asset.service';
import { KindRegistry } from './kind-registry';
import { AUDIO_DESCRIPTOR } from './kinds/audio/audio.descriptor';
import { FONT_DESCRIPTOR } from './kinds/font/font.descriptor';

function assetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'asset-1',
    kind: AssetKind.audio,
    slug: 'rise',
    title: 'Rise',
    authorName: 'SlimShot',
    status: AssetStatus.ready,
    downloadCount: 0,
    visibility: 'public',
    categoryId: null,
    createdAt: new Date('2026-10-01T10:00:00.000Z'),
    publishedAt: null,
    deletedAt: null,
    files: [
      {
        role: FileRole.preview,
        deliveryUrl: 'https://cdn/p.mp3',
        byteSize: 1,
        format: 'mp3',
        durationMs: 1,
        width: null,
        height: null,
        variant: null,
      },
    ],
    audio: { durationMs: 1, bpm: null, isLoopable: false },
    ...overrides,
  };
}

const CATEGORIES = [
  { id: 'cat-ui', kind: AssetKind.audio, parentId: null, isActive: true },
  { id: 'cat-ui-clicks', kind: AssetKind.audio, parentId: 'cat-ui', isActive: false },
  { id: 'cat-other', kind: AssetKind.audio, parentId: null, isActive: true },
  { id: 'cat-font', kind: AssetKind.font, parentId: null, isActive: true },
];

function build(rows: Array<Record<string, unknown>> = [assetRow()]) {
  const prisma = {
    fontAsset: {
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => data),
      delete: jest.fn(async () => ({})),
      // The highest and lowest positions among the fonts the filter matches.
      aggregate: jest.fn(
        async ({ where }: { where: { asset: Record<string, unknown>; assetId?: { not: string } } }) => {
          const orders = rows
            .filter(
              (r) =>
                r.font &&
                r.id !== where.assetId?.not &&
                Object.entries(where.asset).every(([k, v]) => (v === null ? !r[k] : r[k] === v)),
            )
            .map((r) => (r.font as { sortOrder: number }).sortOrder);
          return {
            _max: { sortOrder: orders.length ? Math.max(...orders) : null },
            _min: { sortOrder: orders.length ? Math.min(...orders) : null },
          };
        },
      ),
    },
    category: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        CATEGORIES.find((c) => c.id === where.id) ?? null,
      ),
      findMany: jest.fn(async ({ where }: { where: { kind: string } }) =>
        CATEGORIES.filter((c) => c.kind === where.kind),
      ),
    },
    asset: {
      findMany: jest.fn(async () => rows),
      findFirst: jest.fn(async ({ where }: { where: { id?: string } }) =>
        rows.find((r) => r.id === where.id && !r.deletedAt) ?? null,
      ),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.find((r) => r.id === where.id);
        if (row) {
          const { font, ...rest } = data as { font?: { update: Record<string, unknown> } };
          Object.assign(row, rest);
          if (font) row.font = { ...(row.font as object), ...font.update };
        }
        return row;
      }),
    },
  };

  const cache = { bumpGeneration: jest.fn(async () => undefined) };
  const audit = { record: jest.fn(async () => undefined) };

  const svc = new AssetService(
    prisma as never,
    new KindRegistry([AUDIO_DESCRIPTOR, FONT_DESCRIPTOR]),
    cache as never,
    audit as never,
  );

  return { svc, prisma, cache, audit, rows };
}

describe('AssetService.publish', () => {
  it('publishes a ready asset and stamps publishedAt', async () => {
    const { svc, rows } = build();
    await svc.publish('asset-1', 'admin-1');

    expect(rows[0].status).toBe(AssetStatus.published);
    expect(rows[0].publishedAt).toBeInstanceOf(Date);
  });

  it('refuses to publish an asset still processing', async () => {
    const { svc } = build([assetRow({ status: AssetStatus.processing })]);
    await expect(svc.publish('asset-1', 'admin-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses to publish a failed asset', async () => {
    const { svc } = build([assetRow({ status: AssetStatus.failed })]);
    await expect(svc.publish('asset-1', 'admin-1')).rejects.toThrow(/cannot be published/i);
  });

  it('bumps the cache generation for the kind so browse sees it immediately', async () => {
    const { svc, cache } = build();
    await svc.publish('asset-1', 'admin-1');
    expect(cache.bumpGeneration).toHaveBeenCalledWith('catalog:audio');
  });

  it('writes an audit row naming the actor', async () => {
    const { svc, audit } = build();
    await svc.publish('asset-1', 'admin-1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'asset.publish', actorId: 'admin-1' }),
    );
  });

  it('404s for an unknown asset', async () => {
    const { svc } = build([]);
    await expect(svc.publish('nope', 'admin-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AssetService.unpublish', () => {
  it('returns a published asset to ready and clears publishedAt', async () => {
    const { svc, rows } = build([
      assetRow({ status: AssetStatus.published, publishedAt: new Date() }),
    ]);
    await svc.unpublish('asset-1', 'admin-1');

    expect(rows[0].status).toBe(AssetStatus.ready);
    expect(rows[0].publishedAt).toBeNull();
  });

  it('invalidates the cache so the asset disappears from browse', async () => {
    const { svc, cache } = build([assetRow({ status: AssetStatus.published })]);
    await svc.unpublish('asset-1', 'admin-1');
    expect(cache.bumpGeneration).toHaveBeenCalledWith('catalog:audio');
  });
});

describe('AssetService.softDelete', () => {
  it('sets deletedAt rather than removing the row', async () => {
    const { svc, rows } = build();
    await svc.softDelete('asset-1', 'admin-1');
    expect(rows[0].deletedAt).toBeInstanceOf(Date);
  });

  it('makes the asset unfindable afterwards', async () => {
    const { svc } = build();
    await svc.softDelete('asset-1', 'admin-1');
    await expect(svc.getById('asset-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AssetService.list', () => {
  it('returns a null cursor when the page is not full', async () => {
    const { svc } = build();
    const res = await svc.list({ limit: 25 } as never);
    expect(res.meta.nextCursor).toBeNull();
  });

  it('returns a cursor when a full page is returned', async () => {
    const rows = Array.from({ length: 2 }, (_, i) =>
      assetRow({ id: `asset-${i}`, slug: `s${i}` }),
    );
    const { svc } = build(rows);
    const res = await svc.list({ limit: 2 } as never);
    expect(res.meta.nextCursor).toBe('asset-1');
  });

  it('excludes soft-deleted assets', async () => {
    const { svc, prisma } = build();
    await svc.list({ limit: 25 } as never);
    expect(prisma.asset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ deletedAt: null }) }),
    );
  });
});

describe('AssetService.update', () => {
  it('updates the title and records the actor', async () => {
    const { svc, rows } = build();
    await svc.update('asset-1', { title: 'Rise Higher' }, 'admin-1');

    expect(rows[0].title).toBe('Rise Higher');
    expect(rows[0].updatedById).toBe('admin-1');
  });

});

describe('AssetService admin view', () => {
  const withFiles = () =>
    assetRow({
      categoryId: 'cat-ui',
      files: [
        { role: FileRole.original, deliveryUrl: 'https://cdn.test/slimshot/audio/a.mp3', byteSize: 1000, format: 'mp3', durationMs: 412, width: null, height: null, variant: null },
        { role: FileRole.thumbnail, deliveryUrl: 'https://cdn.test/slimshot/covers/c.png', byteSize: 2000, format: 'png', durationMs: null, width: null, height: null, variant: null },
      ],
    });

  it('shows the admin the status, category, dates, original and cover', async () => {
    const { svc } = build([withFiles()]);
    const view = await svc.getById('asset-1');
    expect(view).toMatchObject({
      status: 'ready',
      visibility: 'public',
      categoryId: 'cat-ui',
      createdAt: '2026-10-01T10:00:00.000Z',
      publishedAt: null,
      files: {
        original: { url: 'https://cdn.test/slimshot/audio/a.mp3', byteSize: 1000, format: 'mp3', durationMs: 412 },
        thumbnail: { url: 'https://cdn.test/slimshot/covers/c.png', byteSize: 2000, format: 'png' },
      },
    });
    expect(view.files.thumbnail).not.toHaveProperty('durationMs');
  });

  it('keeps the public fields the dashboard already reads', async () => {
    const { svc } = build([withFiles()]);
    const view = await svc.getById('asset-1');
    expect(view).toMatchObject({ id: 'asset-1', slug: 'rise', kind: 'audio', title: 'Rise', author: 'SlimShot' });
    expect(view).toHaveProperty('detail');
    expect(view).toHaveProperty('stats');
  });
});

describe('AssetService category assignment', () => {
  it('assigns a category of the asset kind, and clears it with null', async () => {
    const { svc, prisma } = build();
    await svc.update('asset-1', { categoryId: 'cat-ui' }, 'admin-1');
    expect(prisma.asset.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ categoryId: 'cat-ui' }) }),
    );
    await svc.update('asset-1', { categoryId: null }, 'admin-1');
    expect(prisma.asset.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ categoryId: null }) }),
    );
  });

  it('refuses a category of another kind', async () => {
    const { svc, prisma } = build();
    await expect(svc.update('asset-1', { categoryId: 'cat-font' }, 'admin-1')).rejects.toMatchObject({ status: 422 });
    expect(prisma.asset.update).not.toHaveBeenCalled();
  });

  it('clears the app catalogue cache on every update, whatever the status', async () => {
    const { svc, cache } = build(); // asset-1 is `ready`, not published
    await svc.update('asset-1', { title: 'New' }, 'admin-1');
    expect(cache.bumpGeneration).toHaveBeenCalledWith('catalog:audio');
  });
});

describe('AssetService category filter', () => {
  it('filters the list by a category and everything under it, hidden or not', async () => {
    const { svc, prisma } = build();
    await svc.list({ categoryId: 'cat-ui', limit: 25 } as never);
    const where = (prisma.asset.findMany.mock.calls[0] as unknown as [{ where: { categoryId: { in: string[] } } }])[0].where;
    expect(where.categoryId.in.sort()).toEqual(['cat-ui', 'cat-ui-clicks']);
  });

  it('answers an empty page for an unknown category filter', async () => {
    const { svc, prisma } = build();
    const page = await svc.list({ categoryId: 'gone', limit: 25 } as never);
    expect(page).toEqual({ data: [], meta: { nextCursor: null } });
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
  });
});

describe('AssetService font lifecycle', () => {
  const preview = { role: FileRole.specimen, deliveryUrl: 'https://cdn.test/p.png', byteSize: 9, format: 'png', durationMs: null, width: 480, height: 160, variant: null };
  const fontFile = { role: FileRole.original, deliveryUrl: 'https://cdn.test/f.ttf', byteSize: 9, format: 'ttf', durationMs: null, width: null, height: null, variant: { version: 1 } };
  function fontRow(overrides: Record<string, unknown> = {}, font: Record<string, unknown> = {}) {
    return assetRow({
      id: 'font-1',
      kind: AssetKind.font,
      title: 'Lato Regular',
      audio: null,
      files: [fontFile, preview],
      font: {
        familyName: 'Lato', styleName: 'Regular', fullName: 'Lato Regular', postscriptName: 'Lato-Regular',
        version: 1, sortOrder: 0, firstPublishedAt: null, license: 'OFL 1.1', ...font,
      },
      ...overrides,
    });
  }

  it("shows the admin the font's names, version, order, licence and preview", async () => {
    const { svc } = build([fontRow()]);
    const view = await svc.getById('font-1');
    expect(view.font).toEqual({
      familyName: 'Lato', styleName: 'Regular', fullName: 'Lato Regular', postscriptName: 'Lato-Regular',
      version: 1, sortOrder: 0, firstPublishedAt: null, license: 'OFL 1.1',
    });
    expect(view.files.specimen).toMatchObject({ url: 'https://cdn.test/p.png' });
  });

  it("shows the current version's file, never an older one", async () => {
    const v1 = { ...fontFile, deliveryUrl: 'https://cdn.test/v1.ttf', byteSize: 9, isPrimary: false };
    const v2 = { ...fontFile, deliveryUrl: 'https://cdn.test/v2.ttf', byteSize: 12, isPrimary: true, variant: { version: 2 } };
    const { svc } = build([fontRow({ files: [v1, preview, v2] }, { version: 2 })]);
    const view = await svc.getById('font-1');
    expect(view.files.original).toMatchObject({ url: 'https://cdn.test/v2.ttf', byteSize: 12 });
  });

  it('gives sounds no font block', async () => {
    const { svc } = build();
    expect((await svc.getById('asset-1')).font).toBeNull();
  });

  it('refuses to publish a font with no preview', async () => {
    const { svc } = build([fontRow({ files: [fontFile] })]);
    await expect(svc.publish('font-1', 'admin-1')).rejects.toThrow('This font needs a preview before it can be published.');
  });

  it('records the first publish, and keeps that date on later publishes', async () => {
    const { svc, prisma } = build([fontRow()]);
    await svc.publish('font-1', 'admin-1');
    expect(prisma.fontAsset.update).toHaveBeenCalledWith({
      where: { assetId: 'font-1' },
      data: { firstPublishedAt: expect.any(Date) },
    });

    const again = build([fontRow({ status: AssetStatus.archived }, { firstPublishedAt: new Date('2026-10-01') })]);
    await again.svc.publish('font-1', 'admin-1');
    expect(again.prisma.fontAsset.update).not.toHaveBeenCalled();
  });

  it('unpublishes a font that was published, like a sound', async () => {
    const { svc, rows, cache } = build([fontRow({ status: AssetStatus.published }, { firstPublishedAt: new Date('2026-10-01') })]);
    await svc.unpublish('font-1', 'admin-1');
    expect(rows[0]).toMatchObject({ status: AssetStatus.ready, publishedAt: null });
    expect(cache.bumpGeneration).toHaveBeenCalledWith('catalog:font');
  });

  it('deletes a font that was published, and frees its face for a new upload', async () => {
    const { svc, prisma, cache } = build([fontRow({ status: AssetStatus.published }, { firstPublishedAt: new Date('2026-10-01') })]);
    await svc.softDelete('font-1', 'admin-1');
    expect(prisma.asset.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ deletedAt: expect.any(Date) }) }));
    expect(prisma.fontAsset.delete).toHaveBeenCalledWith({ where: { assetId: 'font-1' } });
    expect(cache.bumpGeneration).toHaveBeenCalledWith('catalog:font');
  });

  it('puts a font that becomes published at the top of the order', async () => {
    const live = (id: string, sortOrder: number) =>
      fontRow({ id, status: AssetStatus.published }, { sortOrder, firstPublishedAt: new Date('2026-10-01') });
    const { svc, rows, cache } = build([live('font-a', 0), live('font-b', 3), fontRow({}, { sortOrder: 9 })]);

    await svc.publish('font-1', 'admin-1');
    expect((rows[2].font as { sortOrder: number }).sortOrder).toBe(-1);
    expect(cache.bumpGeneration).toHaveBeenCalledWith('catalog:font');
  });

  it('starts the order at 0 with the first published font', async () => {
    const { svc, rows } = build([fontRow({}, { sortOrder: 5 })]);
    await svc.publish('font-1', 'admin-1');
    expect((rows[0].font as { sortOrder: number }).sortOrder).toBe(0);
  });

  it('puts a font filed into a category at the end of its order', async () => {
    const filed = (id: string, sortOrder: number) =>
      fontRow({ id, categoryId: 'cat-font' }, { sortOrder });
    const loose = fontRow({ id: 'font-new', categoryId: null }, { sortOrder: 0 });
    const { svc, rows } = build([filed('font-a', 0), filed('font-b', 7), loose]);

    await svc.update('font-new', { categoryId: 'cat-font' }, 'admin-1');
    expect((rows[2].font as { sortOrder: number }).sortOrder).toBe(8);
  });

  it('puts a font first when its category has no fonts yet', async () => {
    const { svc, rows } = build([fontRow({ categoryId: null }, { sortOrder: 5 })]);
    await svc.update('font-1', { categoryId: 'cat-font' }, 'admin-1');
    expect((rows[0].font as { sortOrder: number }).sortOrder).toBe(0);
  });

  it("keeps a font's position when its category stays the same, is cleared, or only the name changes", async () => {
    const { svc, prisma } = build([fontRow({ categoryId: 'cat-font' }, { sortOrder: 3 })]);
    await svc.update('font-1', { categoryId: 'cat-font' }, 'admin-1');
    await svc.update('font-1', { title: 'Lato Text' }, 'admin-1');
    await svc.update('font-1', { categoryId: null }, 'admin-1');
    for (const [arg] of prisma.asset.update.mock.calls as unknown as [{ data: Record<string, unknown> }][]) {
      expect(arg.data).not.toHaveProperty('font');
    }
  });

  it('deletes a never-published font and frees its face for a new upload', async () => {
    const { svc, prisma } = build([fontRow()]);
    await svc.softDelete('font-1', 'admin-1');
    expect(prisma.asset.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ deletedAt: expect.any(Date) }) }));
    expect(prisma.fontAsset.delete).toHaveBeenCalledWith({ where: { assetId: 'font-1' } });
  });
});
