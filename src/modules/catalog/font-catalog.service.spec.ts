import { FakeRedis } from '../../../test/fakes/fake-redis';
import { CacheService } from '../../core/cache/cache.service';
import { CatalogService } from './catalog.service';
import { FontCatalogService } from './font-catalog.service';

type Row = Record<string, unknown>;

const CATEGORIES = [
  { id: 'cat-trending', kind: 'font', slug: 'trending', isActive: true, parentId: null },
  { id: 'cat-hidden', kind: 'font', slug: 'hidden', isActive: false, parentId: null },
  { id: 'cat-sfx', kind: 'audio', slug: 'sound-effects', isActive: true, parentId: null },
];

function file(role: string, url: string, extra: Row = {}) {
  return { role, deliveryUrl: url, format: role === 'specimen' ? 'png' : 'ttf', byteSize: 1000, durationMs: null, isPrimary: false, createdAt: new Date('2026-10-01'), ...extra };
}

let n = 0;
function font(id: string, overrides: Row = {}, detail: Row = {}): Row {
  n += 1;
  return {
    id,
    kind: 'font',
    slug: `${id}-slug`,
    title: `Display ${id}`,
    status: 'published',
    visibility: 'public',
    deletedAt: null,
    categoryId: 'cat-trending',
    downloadCount: 0,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, n)),
    files: [
      file('original', `https://cdn.test/slimshot/fonts/${id}.ttf`, { isPrimary: true }),
      file('specimen', `https://cdn.test/slimshot/fonts/previews/${id}.png`),
    ],
    font: {
      familyName: `Family ${id}`,
      styleName: 'Regular',
      familyKey: `family ${id}`,
      styleKey: 'regular',
      postscriptName: `Family${id}-Regular`,
      version: 1,
      sortOrder: n,
      ...detail,
    },
    ...overrides,
  };
}

function library() {
  n = 0;
  return [
    font('second', {}, { sortOrder: 2 }),
    font('first', {}, { sortOrder: 1 }),
    font('draft', { status: 'draft' }),
    font('private', { visibility: 'private' }),
    font('unlisted', { visibility: 'unlisted' }),
    font('deleted', { deletedAt: new Date() }),
    font('loose', { categoryId: null }),
    font('nopreview', {}, { sortOrder: 0 }),
    font('playfair', { categoryId: null }, { familyName: 'Playfair Display', familyKey: 'playfair display', styleName: 'Regular' }),
    font('playfair-bold', { categoryId: null }, { familyName: 'Playfair Display', familyKey: 'playfair display', styleName: 'Bold', styleKey: 'bold' }),
    font('boldonly', { categoryId: null }, { familyName: 'Oswald', familyKey: 'oswald', styleName: 'Bold', styleKey: 'bold' }),
    {
      ...font('versioned', {}, { version: 2, sortOrder: 3 }),
      files: [
        file('original', 'https://cdn.test/slimshot/fonts/v1.ttf', { isPrimary: false, createdAt: new Date('2026-09-01') }),
        file('original', 'https://cdn.test/slimshot/fonts/v2.ttf', { isPrimary: true, createdAt: new Date('2026-10-01') }),
        file('specimen', 'https://cdn.test/slimshot/fonts/previews/versioned.png'),
      ],
    },
    { id: 'sound-1', kind: 'audio', slug: 'boom', title: 'Boom', status: 'published', visibility: 'public', deletedAt: null, categoryId: 'cat-sfx', downloadCount: 0, files: [file('original', 'https://cdn.test/boom.mp3', { isPrimary: true, format: 'mp3', durationMs: 400 })], audio: { durationMs: 400 }, font: null },
  ].map((row) => (row.id === 'nopreview' ? { ...row, files: (row.files as Row[]).filter((f) => f.role !== 'specimen') } : row));
}

/** Evaluates the bits of Prisma's where-language these services use. */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const value = row[k];
    if (k === 'files') {
      const some = (cond as { some: Row }).some;
      return (row.files as Row[]).some((f) => matches(f, some));
    }
    if (k === 'font') return row.font ? matches(row.font as Row, cond as Row) : false;
    if (cond === null) return value === null;
    if (typeof cond === 'object' && cond !== null && !(cond instanceof Date)) {
      const c = cond as Row;
      if ('not' in c) return value !== c.not;
      if ('in' in c) return (c.in as unknown[]).includes(value);
    }
    return value === cond;
  });
}

function shapeFiles(row: Row, include?: Row): Row {
  const arg = include?.files as { where?: Row; orderBy?: Row[]; take?: number } | undefined;
  if (!arg) return row;
  let files = (row.files as Row[]).filter((f) => !arg.where || matches(f, arg.where));
  if (arg.orderBy) {
    files = [...files].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime());
  }
  if (arg.take) files = files.slice(0, arg.take);
  return { ...row, files };
}

function build(rows = library()) {
  const prisma = {
    category: {
      findFirst: jest.fn(async ({ where }: { where: Row }) => CATEGORIES.find((c) => matches(c, where)) ?? null),
    },
    asset: {
      findMany: jest.fn(async ({ where, include, orderBy }: { where: Row; include?: Row; orderBy?: Row[] }) =>
        rows
          .filter((r) => matches(r, where))
          .sort((a, b) => {
            // Applies the orderBy it is given: font.sortOrder, then createdAt or id.
            for (const o of orderBy ?? []) {
              const [field, dir] = Object.entries(o)[0] as [string, unknown];
              const sign = (field === 'font' ? (dir as Row).sortOrder : dir) === 'desc' ? -1 : 1;
              const av = field === 'font' ? ((a.font as Row).sortOrder as number) : a[field];
              const bv = field === 'font' ? ((b.font as Row).sortOrder as number) : b[field];
              const cmp = av instanceof Date ? av.getTime() - (bv as Date).getTime() : av === bv ? 0 : String(av) < String(bv) ? -1 : 1;
              if (typeof av === 'number' && typeof bv === 'number' && av !== bv) return sign * (av - bv);
              if (cmp !== 0) return sign * cmp;
            }
            return 0;
          })
          .map((r) => shapeFiles(r, include)),
      ),
      findFirst: jest.fn(async ({ where, include }: { where: Row; include?: Row }) => {
        const hit = rows.find((r) => matches(r, where));
        return hit ? shapeFiles(hit, include) : null;
      }),
      update: jest.fn(async () => ({})),
    },
  };
  const cache = new CacheService(new FakeRedis() as never);
  return {
    fonts: new FontCatalogService(prisma as never, cache),
    catalog: new CatalogService(prisma as never, cache),
    prisma,
    cache,
  };
}

describe('FontCatalogService.list', () => {
  it('lists the published fonts filed in Trending, in the owner order', async () => {
    const { fonts } = build();
    const items = await fonts.list('trending');
    expect(items.map((i) => i.id)).toEqual(['first', 'second', 'versioned']);
  });

  it('returns exactly the documented fields', async () => {
    const { fonts } = build();
    const [first] = await fonts.list('trending');
    expect(first).toEqual({
      id: 'first',
      displayName: 'Display first',
      familyName: 'Family first',
      styleName: 'Regular',
      version: 1,
      format: 'ttf',
      preview: { url: 'https://cdn.test/slimshot/fonts/previews/first.png', width: 480, height: 160 },
    });
  });

  it('leaves out drafts, deleted, private, unlisted, unfiled and preview-less fonts', async () => {
    const { fonts } = build();
    const ids = (await fonts.list('trending')).map((i) => i.id);
    for (const id of ['draft', 'deleted', 'private', 'unlisted', 'loose', 'nopreview']) expect(ids).not.toContain(id);
  });

  it('404s a missing or hidden category, or a sound category', async () => {
    const { fonts } = build();
    for (const slug of ['nope', 'hidden', 'sound-effects']) {
      await expect(fonts.list(slug)).rejects.toMatchObject({ status: 404, response: { code: 'NOT_FOUND' } });
    }
  });

  it('answers repeat reads from the cache until fonts change', async () => {
    const { fonts, prisma, cache } = build();
    await fonts.list('trending');
    await fonts.list('trending');
    expect(prisma.asset.findMany).toHaveBeenCalledTimes(1);
    await cache.bumpGeneration('catalog:font');
    await fonts.list('trending');
    expect(prisma.asset.findMany).toHaveBeenCalledTimes(2);
  });
});

describe('FontCatalogService.list with no category', () => {
  it('lists every published, public font with a preview, whatever its category', async () => {
    const { fonts } = build();
    const ids = (await fonts.list()).map((i) => i.id);
    expect(ids.sort()).toEqual(['boldonly', 'first', 'loose', 'playfair', 'playfair-bold', 'second', 'versioned'].sort());
  });

  it("follows the owner's order, newest first among equal positions", async () => {
    const rows = library().filter((r) => ['first', 'second', 'versioned', 'loose'].includes(r.id as string));
    // loose and second share position 2; loose was created later, so it comes first.
    const loose = rows.find((r) => r.id === 'loose')!;
    (loose.font as Row).sortOrder = 2;
    loose.createdAt = new Date('2026-10-05');
    const { fonts } = build(rows);
    expect((await fonts.list()).map((i) => i.id)).toEqual(['first', 'loose', 'second', 'versioned']);
  });

  it('returns exactly the documented fields', async () => {
    const { fonts } = build();
    const first = (await fonts.list()).find((i) => i.id === 'first');
    expect(first).toEqual({
      id: 'first',
      displayName: 'Display first',
      familyName: 'Family first',
      styleName: 'Regular',
      version: 1,
      format: 'ttf',
      preview: { url: 'https://cdn.test/slimshot/fonts/previews/first.png', width: 480, height: 160 },
    });
  });

  it('caches the full list apart from a category list', async () => {
    const { fonts, prisma } = build();
    await fonts.list();
    await fonts.list();
    await fonts.list('trending');
    expect(prisma.asset.findMany).toHaveBeenCalledTimes(2);
  });
});

describe('FontCatalogService.byId and byFamily', () => {
  it('finds a published font by id, in Trending or not, unlisted included', async () => {
    const { fonts } = build();
    await expect(fonts.byId('loose')).resolves.toMatchObject({ id: 'loose' });
    await expect(fonts.byId('unlisted')).resolves.toMatchObject({ id: 'unlisted' });
  });

  it.each(['draft', 'deleted', 'private', 'sound-1', 'nope'])('404s %s by id', async (id) => {
    const { fonts } = build();
    await expect(fonts.byId(id)).rejects.toMatchObject({ status: 404 });
  });

  it("finds an old project's font: exact family name, Regular face", async () => {
    const { fonts } = build();
    await expect(fonts.byFamily('Playfair Display')).resolves.toMatchObject({ id: 'playfair', styleName: 'Regular' });
  });

  it('404s a family without a Regular face, or spelled differently', async () => {
    const { fonts } = build();
    await expect(fonts.byFamily('Oswald')).rejects.toMatchObject({ status: 404 });
    await expect(fonts.byFamily('playfair display')).rejects.toMatchObject({ status: 404 });
  });

  it('still works when Trending is hidden or missing', async () => {
    const { fonts } = build(library().map((r) => ({ ...r, categoryId: r.categoryId === 'cat-trending' ? 'cat-hidden' : r.categoryId })));
    await expect(fonts.list('trending')).resolves.toEqual([]);
    await expect(fonts.byId('first')).resolves.toMatchObject({ id: 'first' });
    await expect(fonts.byFamily('Playfair Display')).resolves.toMatchObject({ id: 'playfair' });
  });
});

describe('Downloading fonts', () => {
  afterEach(() => jest.useRealTimers());

  it('downloads the current version, never an older file', async () => {
    const { catalog } = build();
    await expect(catalog.download('versioned')).resolves.toMatchObject({
      url: 'https://cdn.test/slimshot/fonts/v2.ttf',
      version: 2,
    });
  });

  it("names the file after the font's PostScript name and counts it", async () => {
    jest.useFakeTimers({ now: new Date('2026-10-22T12:00:00.000Z') });
    const { catalog, prisma } = build();
    await expect(catalog.download('first')).resolves.toEqual({
      url: 'https://cdn.test/slimshot/fonts/first.ttf',
      expiresAt: '2026-10-22T12:10:00.000Z',
      filename: 'Familyfirst-Regular.ttf',
      format: 'ttf',
      byteSize: 1000,
      version: 1,
    });
    expect(prisma.asset.update).toHaveBeenCalledWith({ where: { id: 'first' }, data: { downloadCount: { increment: 1 } } });
  });

  it('downloads a font that left Trending', async () => {
    const { catalog } = build();
    await expect(catalog.download('loose')).resolves.toMatchObject({ filename: 'Familyloose-Regular.ttf' });
  });

  it('keeps the sound download exactly as it was', async () => {
    const { catalog } = build();
    const ticket = await catalog.download('sound-1');
    expect(Object.keys(ticket).sort()).toEqual(['byteSize', 'durationMs', 'expiresAt', 'filename', 'format', 'url']);
  });

  it('points font listings at /catalog/fonts instead of the sounds endpoint', async () => {
    const { catalog } = build();
    await expect(catalog.assets({ kind: 'font' as never, limit: 30 })).rejects.toMatchObject({
      status: 422,
      response: { message: 'Fonts are listed at /catalog/fonts.' },
    });
  });
});
