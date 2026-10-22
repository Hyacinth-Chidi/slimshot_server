import { AssetKind, AssetStatus } from '../../generated/prisma/enums';
import { FontsService, LEGACY_FAMILIES } from './fonts.service';

type Row = Record<string, unknown>;

const TRENDING = [
  { id: 'f-a', title: 'Lato Regular', status: AssetStatus.published, font: { styleName: 'Regular', sortOrder: 0 }, files: [{ deliveryUrl: 'https://cdn.test/a.png' }] },
  { id: 'f-b', title: 'Lato Bold', status: AssetStatus.ready, font: { styleName: 'Bold', sortOrder: 1 }, files: [] },
];

function build(opts: { fonts?: Row[]; legacy?: Row[]; asset?: Row | null } = {}) {
  const prisma = {
    asset: {
      // Honours the one filter that matters here: `font: { isNot: null }`.
      findMany: jest.fn(async ({ where }: { where?: { font?: object } } = {}) =>
        (opts.fonts ?? TRENDING).filter((r) => !where?.font || r.font !== null),
      ),
      findFirst: jest.fn(async () => (opts.asset === undefined ? { id: 'f-a', kind: AssetKind.font } : opts.asset)),
    },
    fontAsset: {
      // Like the database: a row that does not exist cannot be updated (P2025).
      update: jest.fn(async ({ where, data }: { where: { assetId: string }; data: Row }) => {
        const rows = opts.fonts ?? TRENDING;
        const row = rows.find((r) => r.id === where.assetId);
        if (row && row.font === null) throw Object.assign(new Error('Record to update not found.'), { code: 'P2025' });
        return data;
      }),
      findMany: jest.fn(async () => opts.legacy ?? []),
    },
    $transaction: jest.fn(async (ops: unknown[]) => ops),
  };
  const cache = { bumpGeneration: jest.fn(async () => true) };
  const audit = { record: jest.fn(async () => undefined) };
  const svc = new FontsService(prisma as never, {} as never, cache as never, audit as never, {} as never);
  return { svc, prisma, cache, audit };
}

describe('FontsService admin: Trending order', () => {
  it('lists the fonts of a category by position, with their preview', async () => {
    const { svc, prisma } = build();
    await expect(svc.order('trending')).resolves.toEqual([
      { id: 'f-a', title: 'Lato Regular', styleName: 'Regular', previewUrl: 'https://cdn.test/a.png', status: 'published' },
      { id: 'f-b', title: 'Lato Bold', styleName: 'Bold', previewUrl: null, status: 'ready' },
    ]);
    expect(prisma.asset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { kind: AssetKind.font, deletedAt: null, categoryId: 'trending', font: { isNot: null } },
        orderBy: [{ font: { sortOrder: 'asc' } }, { id: 'asc' }],
      }),
    );
  });

  it('saves a new order: each font takes its index', async () => {
    const { svc, prisma, cache } = build();
    await svc.reorder('trending', ['f-b', 'f-a'], 'admin-1');
    expect(prisma.fontAsset.update).toHaveBeenNthCalledWith(1, { where: { assetId: 'f-b' }, data: { sortOrder: 0 } });
    expect(prisma.fontAsset.update).toHaveBeenNthCalledWith(2, { where: { assetId: 'f-a' }, data: { sortOrder: 1 } });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(cache.bumpGeneration).toHaveBeenCalledWith('catalog:font');
  });

  it('leaves out an upload that was refused or never finished, so the order still saves', async () => {
    // A font upload filed in Trending creates its asset at ticket time; a
    // refused or abandoned one never gets font details.
    const leftover = { id: 'f-failed', title: 'broken.ttf', status: AssetStatus.failed, font: null, files: [] };
    const { svc, prisma } = build({ fonts: [...TRENDING, leftover] });

    expect((await svc.order('trending')).map((f) => f.id)).toEqual(['f-a', 'f-b']);
    await expect(svc.reorder('trending', ['f-b', 'f-a'], 'admin-1')).resolves.toBeUndefined();
    expect(prisma.fontAsset.update).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['an id outside the category', ['f-a', 'f-x']],
    ['a duplicate id', ['f-a', 'f-a']],
    ['a missing font', ['f-a']],
  ])('refuses %s and changes nothing', async (_name, ids) => {
    const { svc, prisma } = build();
    await expect(svc.reorder('trending', ids, 'admin-1')).rejects.toMatchObject({ status: 422 });
    expect(prisma.fontAsset.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('FontsService admin: licence', () => {
  it('stores the licence note of a font', async () => {
    const { svc, prisma } = build();
    await svc.updateLicense('f-a', 'OFL 1.1, Google Fonts', 'admin-1');
    expect(prisma.fontAsset.update).toHaveBeenCalledWith({ where: { assetId: 'f-a' }, data: { license: 'OFL 1.1, Google Fonts' } });
  });

  it('404s anything that is not a font', async () => {
    const { svc } = build({ asset: null });
    await expect(svc.updateLicense('a-1', 'x', 'admin-1')).rejects.toMatchObject({ status: 404 });
  });
});

describe('FontsService admin: the 19 families old projects use', () => {
  it('lists the 19 names in order, with the Regular font each one finds', async () => {
    const { svc } = build({
      legacy: [
        { assetId: 'f-lato', familyKey: 'lato', asset: { status: AssetStatus.published } },
        { assetId: 'f-pop', familyKey: 'poppins', asset: { status: AssetStatus.ready } },
      ],
    });
    const rows = await svc.legacyFamilies();
    expect(rows).toHaveLength(19);
    expect(rows.map((r) => r.familyName)).toEqual(LEGACY_FAMILIES);
    expect(rows.find((r) => r.familyName === 'Lato')).toEqual({ familyName: 'Lato', fontId: 'f-lato', published: true });
    expect(rows.find((r) => r.familyName === 'Poppins')).toEqual({ familyName: 'Poppins', fontId: 'f-pop', published: false });
    expect(rows.find((r) => r.familyName === 'Cinzel')).toEqual({ familyName: 'Cinzel', fontId: null, published: false });
  });

  it('spells the names exactly as old projects store them', () => {
    expect(LEGACY_FAMILIES).toEqual([
      'Montserrat', 'Lato', 'Oswald', 'Bebas Neue', 'Playfair Display', 'Pacifico', 'Dancing Script', 'Poppins',
      'Raleway', 'Inter', 'Nunito', 'Lobster', 'Caveat', 'Abril Fatface', 'Righteous', 'Permanent Marker',
      'Press Start 2P', 'Cinzel', 'Sacramento',
    ]);
  });
});
