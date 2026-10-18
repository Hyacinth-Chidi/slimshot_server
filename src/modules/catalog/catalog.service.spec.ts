import { FakeRedis } from '../../../test/fakes/fake-redis';
import { CacheService } from '../../core/cache/cache.service';
import { CatalogService } from './catalog.service';
import * as entitlement from './entitlement';

type Row = Record<string, unknown>;

interface Cat {
  id: string;
  kind: string;
  parentId: string | null;
  slug: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

const CATEGORIES: Cat[] = [
  { id: 'sfx', kind: 'audio', parentId: null, slug: 'sound-effects', name: 'Sound effects', sortOrder: 0, isActive: true },
  { id: 'ui', kind: 'audio', parentId: 'sfx', slug: 'ui', name: 'UI', sortOrder: 2, isActive: true },
  { id: 'alerts', kind: 'audio', parentId: 'sfx', slug: 'alerts', name: 'Alerts', sortOrder: 1, isActive: true },
  { id: 'ui-clicks', kind: 'audio', parentId: 'ui', slug: 'ui-clicks', name: 'UI clicks', sortOrder: 0, isActive: true },
  { id: 'hidden', kind: 'audio', parentId: 'sfx', slug: 'hidden', name: 'Hidden', sortOrder: 3, isActive: false },
  { id: 'under-hidden', kind: 'audio', parentId: 'hidden', slug: 'under-hidden', name: 'Under hidden', sortOrder: 0, isActive: true },
  { id: 'off-root', kind: 'audio', parentId: null, slug: 'off-root', name: 'Off', sortOrder: 1, isActive: false },
  { id: 'fonts', kind: 'font', parentId: null, slug: 'serif', name: 'Serif', sortOrder: 0, isActive: true },
];

function file(role: string, url: string, extra: Row = {}) {
  return { role, deliveryUrl: url, format: 'mp3', byteSize: 1000, durationMs: 400, ...extra };
}

let day = 0;
function asset(id: string, overrides: Row = {}): Row {
  day += 1;
  return {
    id,
    kind: 'audio',
    slug: `${id}-slug`,
    title: `Title ${id}`,
    authorName: 'SlimShot',
    status: 'published',
    visibility: 'public',
    deletedAt: null,
    categoryId: 'ui',
    publishedAt: new Date(Date.UTC(2026, 9, day)),
    downloadCount: 0,
    audio: { durationMs: 412 },
    files: [file('original', `https://cdn.test/slimshot/audio/${id}.mp3`)],
    ...overrides,
  };
}

/** Evaluates the subset of Prisma's where-language the catalogue uses. */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Row[]).every((w) => matches(row, w));
    if (key === 'OR') return (cond as Row[]).some((w) => matches(row, w));
    const value = row[key];
    if (cond === null) return value === null;
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    if (typeof cond === 'object') {
      const c = cond as Row;
      if ('in' in c) return (c.in as unknown[]).includes(value);
      if ('not' in c) return value !== c.not;
      if ('lt' in c) {
        const limit = c.lt as Date | string;
        return limit instanceof Date ? (value as Date).getTime() < limit.getTime() : String(value) < limit;
      }
    }
    return value === cond;
  });
}

function prismaWith(assets: Row[]) {
  const byPublished = (a: Row, b: Row) => {
    const d = (b.publishedAt as Date).getTime() - (a.publishedAt as Date).getTime();
    return d !== 0 ? d : String(b.id) < String(a.id) ? -1 : 1;
  };
  const shape = (a: Row, include?: Row) => {
    if (!include) return a;
    const filesArg = include.files as { where?: { role: string } } | undefined;
    const files = (a.files as Row[]).filter((f) => !filesArg?.where || f.role === filesArg.where.role);
    const category = CATEGORIES.find((c) => c.id === a.categoryId);
    return {
      ...a,
      files,
      category: category ? { slug: category.slug, name: category.name } : null,
    };
  };
  return {
    category: {
      findMany: jest.fn(async ({ where }: { where: { kind: string } }) =>
        [...CATEGORIES]
          .filter((c) => c.kind === where.kind)
          .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
      ),
    },
    asset: {
      findFirst: jest.fn(async ({ where, include }: { where: Row; include?: Row }) => {
        const hit = assets.find((a) => matches(a, where));
        return hit ? shape(hit, include) : null;
      }),
      findMany: jest.fn(async ({ where, take, include }: { where: Row; take: number; include?: Row }) =>
        assets
          .filter((a) => matches(a, where))
          .sort(byPublished)
          .slice(0, take)
          .map((a) => shape(a, include)),
      ),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = assets.find((a) => a.id === where.id)!;
        const inc = (data.downloadCount as { increment: number } | undefined)?.increment ?? 0;
        row.downloadCount = (row.downloadCount as number) + inc;
        return row;
      }),
    },
  };
}

function build(assets: Row[]) {
  const prisma = prismaWith(assets);
  const cache = new CacheService(new FakeRedis() as never);
  return { svc: new CatalogService(prisma as never, cache), prisma, cache, assets };
}

function library() {
  day = 0;
  return [
    asset('a1', { categoryId: 'ui', files: [file('original', 'https://cdn.test/slimshot/audio/a1.mp3'), file('thumbnail', 'https://cdn.test/slimshot/covers/a1.png', { format: 'png' })] }),
    asset('a2', { categoryId: 'ui-clicks' }),
    asset('a3', { categoryId: 'alerts' }),
    asset('draft', { status: 'draft' }),
    asset('ready', { status: 'ready', publishedAt: null }),
    asset('unlisted', { visibility: 'unlisted' }),
    asset('private', { visibility: 'private' }),
    asset('deleted', { deletedAt: new Date() }),
    asset('in-hidden', { categoryId: 'under-hidden' }),
    asset('unfiled', { categoryId: null }),
    asset('a-font', { kind: 'font', categoryId: 'fonts' }),
  ];
}

const ids = (items: Array<{ id: string }>) => items.map((i) => i.id).sort();

describe('CatalogService.categories', () => {
  it("returns the root's active children in order, nested, without hidden branches", async () => {
    const { svc } = build(library());
    expect(await svc.categories('audio' as never, 'sound-effects')).toEqual([
      { id: 'alerts', slug: 'alerts', name: 'Alerts', children: [] },
      {
        id: 'ui',
        slug: 'ui',
        name: 'UI',
        children: [{ id: 'ui-clicks', slug: 'ui-clicks', name: 'UI clicks', children: [] }],
      },
    ]);
  });

  it.each([
    ['an unknown root', 'nope'],
    ['an inactive root', 'off-root'],
    ['a category that is not top-level', 'ui'],
  ])('404s %s', async (_name, root) => {
    const { svc } = build(library());
    await expect(svc.categories('audio' as never, root)).rejects.toMatchObject({
      status: 404,
      response: { code: 'NOT_FOUND' },
    });
  });

  it("never finds another kind's categories", async () => {
    const { svc } = build(library());
    await expect(svc.categories('audio' as never, 'serif')).rejects.toMatchObject({ status: 404 });
  });
});

describe('CatalogService.assets', () => {
  it('lists only published, public, not-deleted sounds of the kind', async () => {
    const { svc } = build(library());
    const page = await svc.assets({ kind: 'audio' as never, category: 'sound-effects', limit: 30 });
    expect(ids(page.items)).toEqual(['a1', 'a2', 'a3']);
  });

  it('leaves out sounds in hidden subcategories', async () => {
    const { svc } = build(library());
    const page = await svc.assets({ kind: 'audio' as never, category: 'sound-effects', limit: 30 });
    expect(ids(page.items)).not.toContain('in-hidden');
  });

  it('includes subcategories of the chosen category', async () => {
    const { svc } = build(library());
    const page = await svc.assets({ kind: 'audio' as never, category: 'ui', limit: 30 });
    expect(ids(page.items)).toEqual(['a1', 'a2']);
  });

  it('404s a hidden or unknown category', async () => {
    const { svc } = build(library());
    await expect(svc.assets({ kind: 'audio' as never, category: 'hidden', limit: 30 })).rejects.toMatchObject({
      status: 404,
    });
    await expect(svc.assets({ kind: 'audio' as never, category: 'nope', limit: 30 })).rejects.toMatchObject({
      status: 404,
    });
  });

  it('lists every listed sound of the kind when no category is given, unfiled ones too', async () => {
    const { svc } = build(library());
    const page = await svc.assets({ kind: 'audio' as never, limit: 30 });
    expect(ids(page.items)).toEqual(['a1', 'a2', 'a3', 'in-hidden', 'unfiled']);
    expect(page.items.find((i) => i.id === 'unfiled')!.category).toBeNull();
  });

  it('never exposes the original, and returns exactly the documented fields', async () => {
    const { svc } = build(library());
    const page = await svc.assets({ kind: 'audio' as never, category: 'ui', limit: 30 });
    expect(JSON.stringify(page)).not.toContain('/slimshot/audio/');
    expect(Object.keys(page.items[0]).sort()).toEqual([
      'author',
      'category',
      'cover',
      'durationMs',
      'id',
      'slug',
      'title',
    ]);
  });

  it('gives the cover from the thumbnail, or null, and the category name', async () => {
    const { svc } = build(library());
    const page = await svc.assets({ kind: 'audio' as never, category: 'ui', limit: 30 });
    const a1 = page.items.find((i) => i.id === 'a1')!;
    const a2 = page.items.find((i) => i.id === 'a2')!;
    expect(a1).toMatchObject({
      title: 'Title a1',
      author: 'SlimShot',
      durationMs: 412,
      category: { slug: 'ui', name: 'UI' },
      cover: { url: 'https://cdn.test/slimshot/covers/a1.png' },
    });
    expect(a2.cover).toBeNull();
    expect(a2.category).toEqual({ slug: 'ui-clicks', name: 'UI clicks' });
  });

  it('pages newest first with a keyset cursor, ties broken by id', async () => {
    day = 0;
    const same = new Date(Date.UTC(2026, 9, 20));
    const rows = [
      asset('a'),
      asset('b'),
      asset('c'),
      asset('d', { publishedAt: same }),
      asset('e', { publishedAt: same }),
    ];
    const { svc } = build(rows);
    const q = { kind: 'audio' as never, category: 'ui', limit: 2 };

    const p1 = await svc.assets(q);
    expect(p1.items.map((i) => i.id)).toEqual(['e', 'd']);
    const p2 = await svc.assets({ ...q, cursor: p1.nextCursor! });
    expect(p2.items.map((i) => i.id)).toEqual(['c', 'b']);
    const p3 = await svc.assets({ ...q, cursor: p2.nextCursor! });
    expect(p3.items.map((i) => i.id)).toEqual(['a']);
    expect(p3.nextCursor).toBeNull();
  });

  it('says there is no next page when the last page is exactly full', async () => {
    const { svc } = build(library());
    const page = await svc.assets({ kind: 'audio' as never, category: 'ui', limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it.each([
    ['an unpublished sound', 'draft'],
    ['a sound of another kind', 'a-font'],
    ['an unknown id', 'nope'],
  ])('422s a cursor that is not in this listing: %s', async (_name, cursor) => {
    const { svc } = build(library());
    await expect(svc.assets({ kind: 'audio' as never, category: 'sound-effects', cursor, limit: 2 })).rejects.toMatchObject({
      status: 422,
      response: { code: 'VALIDATION_FAILED' },
    });
  });

  it('answers repeat reads from the cache until the catalogue changes', async () => {
    const { svc, prisma, cache } = build(library());
    const q = { kind: 'audio' as never, category: 'ui', limit: 30 };
    await svc.assets(q);
    await svc.assets(q);
    expect(prisma.asset.findMany).toHaveBeenCalledTimes(1);

    await cache.bumpGeneration('catalog:audio');
    await svc.assets(q);
    expect(prisma.asset.findMany).toHaveBeenCalledTimes(2);
  });
});

describe('CatalogService.download', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('hands out the original for ten minutes and counts the download', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-18T12:00:00.000Z') });
    const { svc, assets } = build(library());
    const ticket = await svc.download('a1');
    expect(ticket).toEqual({
      url: 'https://cdn.test/slimshot/audio/a1.mp3',
      expiresAt: '2026-10-18T12:10:00.000Z',
      filename: 'a1-slug.mp3',
      format: 'mp3',
      byteSize: 1000,
      durationMs: 400,
    });
    expect(assets.find((a) => a.id === 'a1')!.downloadCount).toBe(1);
  });

  it.each(['nope', 'draft', 'deleted', 'private'])('404s %s', async (id) => {
    const { svc, prisma } = build(library());
    await expect(svc.download(id)).rejects.toMatchObject({ status: 404, response: { code: 'NOT_FOUND' } });
    expect(prisma.asset.update).not.toHaveBeenCalled();
  });

  it('lets an unlisted sound be downloaded by direct id', async () => {
    const { svc } = build(library());
    await expect(svc.download('unlisted')).resolves.toMatchObject({ filename: 'unlisted-slug.mp3' });
  });

  it('refuses with 403 when the entitlement check says no, without counting', async () => {
    jest.spyOn(entitlement, 'canDownload').mockReturnValue(false);
    const { svc, prisma } = build(library());
    await expect(svc.download('a1')).rejects.toMatchObject({ status: 403, response: { code: 'FORBIDDEN' } });
    expect(prisma.asset.update).not.toHaveBeenCalled();
  });
});
