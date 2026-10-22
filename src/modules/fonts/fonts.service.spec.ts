import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { probeFont } from '../../core/storage/font-probe';
import { UnreadableUploadError } from '../../core/storage/storage-adapter.interface';
import { AssetKind, AssetStatus, FileRole } from '../../generated/prisma/enums';
import * as preview from './font-preview';
import { FontsService } from './fonts.service';

const FONTS = join(__dirname, '../../../test/fixtures/fonts');
const LATO = readFileSync(join(FONTS, 'Lato-Regular.ttf'));

const LATO_NAMES = { familyName: 'Lato', styleName: 'Regular', fullName: 'Lato Regular', postscriptName: 'Lato-Regular' };
const BOLD_NAMES = { familyName: 'Lato', styleName: 'Bold', fullName: 'Lato Bold', postscriptName: 'Lato-Bold' };

function remote(details = LATO_NAMES, overrides: Record<string, unknown> = {}) {
  return {
    storageKey: 'slimshot/fonts/new.ttf',
    byteSize: 656_568,
    format: 'ttf',
    mimeType: 'font/ttf',
    deliveryUrl: 'https://cdn.test/slimshot/fonts/new.ttf',
    details,
    ...overrides,
  };
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess-f',
    assetId: 'font-1',
    role: FileRole.original,
    storageId: 'prov-1',
    storageKey: 'slimshot/fonts/new.ttf',
    declaredMime: 'font/ttf',
    asset: { id: 'font-1', kind: AssetKind.font, status: AssetStatus.draft, categoryId: 'trending', title: 'Lato-Regular' },
    ...overrides,
  };
}

type Row = Record<string, unknown>;

function build(opts: { font?: Row | null; taken?: boolean; maxOrder?: number | null; specimen?: Row[] } = {}) {
  const files: Row[] = [
    { id: 'f-orig-1', assetId: 'font-1', role: FileRole.original, storageId: 'prov-1', storageKey: 'slimshot/fonts/old.ttf', isPrimary: true },
    ...(opts.specimen ?? []),
  ];
  const adapter = {
    id: 'prov-1',
    verifyUpload: jest.fn(async (): Promise<unknown> => remote()),
    getObject: jest.fn(async () => LATO),
    putObject: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined),
    getDeliveryUrl: jest.fn((key: string) => `https://cdn.test/${key}`),
  };
  const prisma = {
    fontAsset: {
      findUnique: jest.fn(async ({ where }: { where: Row }) => {
        if ('assetId' in where) return opts.font ?? null;
        return opts.taken ? { assetId: 'font-other' } : null;
      }),
      aggregate: jest.fn(async () => ({ _max: { sortOrder: opts.maxOrder ?? null } })),
      create: jest.fn(async ({ data }: { data: Row }) => data),
      update: jest.fn(async ({ data }: { data: Row }) => data),
    },
    asset: {
      update: jest.fn(async ({ data }: { data: Row }) => data),
      findFirst: jest.fn(async () => ({ id: 'font-1', kind: AssetKind.font, title: 'Lato Regular', deletedAt: null })),
    },
    assetFile: {
      create: jest.fn(async ({ data }: { data: Row }) => {
        files.push(data);
        return data;
      }),
      updateMany: jest.fn(async () => ({ count: 1 })),
      findFirst: jest.fn(async ({ where }: { where: Row }) =>
        files.find((f) => f.role === where.role && (where.isPrimary === undefined || f.isPrimary === where.isPrimary)) ?? null,
      ),
      findMany: jest.fn(async ({ where }: { where: Row }) => files.filter((f) => f.role === where.role)),
      deleteMany: jest.fn(async () => ({ count: 1 })),
    },
    uploadSession: { update: jest.fn(async () => ({})) },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(prisma)),
  };
  const storage = { get: jest.fn(async () => adapter) };
  const cache = { bumpGeneration: jest.fn(async () => true) };
  const audit = { record: jest.fn(async () => undefined) };
  const upload = { limits: { font: { maxBytes: 10_485_760, mimeTypes: ['font/ttf', 'font/otf'] } } };
  const svc = new FontsService(prisma as never, storage as never, cache as never, audit as never, upload as never);
  return { svc, prisma, adapter, cache, files };
}

afterEach(() => jest.restoreAllMocks());

describe('FontsService.finalizeUpload: a new font', () => {
  it('records the face, keeps the file, draws the preview and names the font from the file', async () => {
    const { svc, prisma, adapter, cache, files } = build({ maxOrder: 4 });

    await expect(svc.finalizeUpload(session() as never, adapter as never, 'admin-1')).resolves.toEqual({
      assetId: 'font-1',
      status: AssetStatus.ready,
    });

    expect(adapter.verifyUpload).toHaveBeenCalledWith('slimshot/fonts/new.ttf', probeFont);
    expect(prisma.fontAsset.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        assetId: 'font-1',
        familyName: 'Lato',
        styleName: 'Regular',
        fullName: 'Lato Regular',
        postscriptName: 'Lato-Regular',
        familyKey: 'lato',
        styleKey: 'regular',
        version: 1,
        sortOrder: 5,
      }),
    });
    expect(prisma.asset.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ title: 'Lato Regular', status: AssetStatus.ready }) }),
    );
    expect(files).toContainEqual(
      expect.objectContaining({ role: FileRole.original, isPrimary: true, variant: { version: 1 }, storageKey: 'slimshot/fonts/new.ttf' }),
    );
    const put = adapter.putObject.mock.calls[0] as unknown as [string, Buffer, string];
    expect(put[0]).toMatch(/^slimshot\/fonts\/previews\/[0-9a-f-]{36}\.png$/);
    expect(put[2]).toBe('image/png');
    expect(files).toContainEqual(
      expect.objectContaining({ role: FileRole.specimen, width: 480, height: 160, mimeType: 'image/png' }),
    );
    expect(cache.bumpGeneration).toHaveBeenCalledWith('catalog:font');
  });

  it('puts the first font of a category at the top of the order', async () => {
    const { svc, prisma, adapter } = build({ maxOrder: null });
    await svc.finalizeUpload(session() as never, adapter as never, 'admin-1');
    expect(prisma.fontAsset.create).toHaveBeenCalledWith({ data: expect.objectContaining({ sortOrder: 0 }) });
  });

  it('refuses a face already in the library and deletes the upload', async () => {
    const { svc, prisma, adapter } = build({ taken: true });
    await expect(svc.finalizeUpload(session() as never, adapter as never, 'admin-1')).rejects.toThrow(
      'Lato Regular is already in the library.',
    );
    expect(adapter.delete).toHaveBeenCalledWith('slimshot/fonts/new.ttf');
    expect(prisma.fontAsset.create).not.toHaveBeenCalled();
  });

  it('a duplicate caught by the database is refused like any other', async () => {
    const { svc, prisma, adapter } = build();
    prisma.fontAsset.create.mockRejectedValueOnce(Object.assign(new Error('Unique constraint'), { code: 'P2002' }));
    await expect(svc.finalizeUpload(session() as never, adapter as never, 'admin-1')).rejects.toThrow(
      'Lato Regular is already in the library.',
    );
    expect(adapter.delete).toHaveBeenCalledWith('slimshot/fonts/new.ttf');
  });

  it('refuses what the checker refuses, marks the font failed and deletes the upload', async () => {
    const { svc, prisma, adapter } = build();
    adapter.verifyUpload.mockRejectedValueOnce(new UnreadableUploadError('This is a WOFF2 web font. Upload the TTF or OTF file.'));
    await expect(svc.finalizeUpload(session() as never, adapter as never, 'admin-1')).rejects.toThrow('WOFF2');
    expect(prisma.asset.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: AssetStatus.failed } }));
    expect(adapter.delete).toHaveBeenCalledWith('slimshot/fonts/new.ttf');
  });

  it('refuses an OTF that was uploaded as a TTF', async () => {
    const { svc, adapter } = build();
    adapter.verifyUpload.mockResolvedValueOnce(remote(LATO_NAMES, { format: 'otf', mimeType: 'font/otf' }));
    await expect(svc.finalizeUpload(session() as never, adapter as never, 'admin-1')).rejects.toThrow(
      'The file is OTF (font/otf), but it was uploaded as font/ttf.',
    );
  });

  it('still records the font when its preview cannot be drawn', async () => {
    jest.spyOn(preview, 'renderFontPreview').mockImplementation(() => {
      throw new Error('The font draws nothing for this text.');
    });
    const { svc, prisma, adapter } = build();
    await expect(svc.finalizeUpload(session() as never, adapter as never, 'admin-1')).resolves.toMatchObject({
      status: AssetStatus.ready,
    });
    expect(prisma.fontAsset.create).toHaveBeenCalled();
    expect(adapter.putObject).not.toHaveBeenCalled();
  });
});

describe('FontsService.finalizeUpload: a new version', () => {
  const EXISTING = { assetId: 'font-1', familyName: 'Lato', styleName: 'Regular', familyKey: 'lato', styleKey: 'regular', version: 1 };
  const OLD_PREVIEW = { id: 'p-old', assetId: 'font-1', role: FileRole.specimen, storageId: 'prov-1', storageKey: 'slimshot/fonts/previews/old.png' };
  const published = session({ asset: { ...session().asset, status: AssetStatus.published } });

  it('keeps the old file, bumps the version and redraws the preview', async () => {
    const { svc, prisma, adapter, cache, files } = build({ font: EXISTING, specimen: [OLD_PREVIEW] });

    await expect(svc.finalizeUpload(published as never, adapter as never, 'admin-1')).resolves.toEqual({
      assetId: 'font-1',
      status: AssetStatus.published,
    });

    expect(prisma.assetFile.updateMany).toHaveBeenCalledWith({
      where: { assetId: 'font-1', role: FileRole.original },
      data: { isPrimary: false },
    });
    expect(files).toContainEqual(expect.objectContaining({ role: FileRole.original, isPrimary: true, variant: { version: 2 } }));
    expect(prisma.fontAsset.update).toHaveBeenCalledWith({ where: { assetId: 'font-1' }, data: { version: 2 } });
    expect(adapter.putObject).toHaveBeenCalled();
    expect(adapter.delete).toHaveBeenCalledWith('slimshot/fonts/previews/old.png');
    expect(prisma.fontAsset.create).not.toHaveBeenCalled();
    expect(cache.bumpGeneration).toHaveBeenCalledWith('catalog:font');
  });

  it('refuses a file of another face, changing nothing', async () => {
    const { svc, prisma, adapter } = build({ font: EXISTING });
    adapter.verifyUpload.mockResolvedValueOnce(remote(BOLD_NAMES));
    await expect(svc.finalizeUpload(published as never, adapter as never, 'admin-1')).rejects.toThrow(
      'This file is Lato Bold, not Lato Regular.',
    );
    expect(adapter.delete).toHaveBeenCalledWith('slimshot/fonts/new.ttf');
    expect(prisma.fontAsset.update).not.toHaveBeenCalled();
    expect(prisma.asset.update).not.toHaveBeenCalled();
  });

  it('a failed redraw keeps the previous preview', async () => {
    jest.spyOn(preview, 'renderFontPreview').mockImplementation(() => {
      throw new Error('boom');
    });
    const { svc, prisma, adapter } = build({ font: EXISTING, specimen: [OLD_PREVIEW] });
    await svc.finalizeUpload(published as never, adapter as never, 'admin-1');
    expect(prisma.fontAsset.update).toHaveBeenCalledWith({ where: { assetId: 'font-1' }, data: { version: 2 } });
    expect(prisma.assetFile.deleteMany).not.toHaveBeenCalled();
    expect(adapter.delete).not.toHaveBeenCalledWith('slimshot/fonts/previews/old.png');
  });
});

describe('FontsService.refreshPreview', () => {
  it('draws the current title from the current file and replaces the old preview', async () => {
    const OLD_PREVIEW = { id: 'p-old', assetId: 'font-1', role: FileRole.specimen, storageId: 'prov-1', storageKey: 'slimshot/fonts/previews/old.png' };
    const { svc, prisma, adapter } = build({ specimen: [OLD_PREVIEW] });
    await expect(svc.refreshPreview('font-1')).resolves.toBe(true);
    expect(adapter.getObject).toHaveBeenCalledWith('slimshot/fonts/old.ttf');
    expect(prisma.assetFile.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['p-old'] } } });
    expect(adapter.delete).toHaveBeenCalledWith('slimshot/fonts/previews/old.png');
  });

  it('answers false and changes nothing when drawing fails', async () => {
    jest.spyOn(preview, 'renderFontPreview').mockImplementation(() => {
      throw new Error('boom');
    });
    const { svc, prisma, adapter } = build();
    await expect(svc.refreshPreview('font-1')).resolves.toBe(false);
    expect(adapter.putObject).not.toHaveBeenCalled();
    expect(prisma.assetFile.create).not.toHaveBeenCalled();
  });
});
