jest.mock('cloudinary', () => ({
  v2: { config: jest.fn(), url: jest.fn(), utils: {}, api: {}, uploader: {} },
}));

import { StorageRegistry } from './storage.registry';

const CLOUDINARY = {
  cloudName: 'demo',
  apiKey: 'key-1',
  apiSecret: 'secret-1',
  folder: 'slimshot/audio',
};

function prismaWith(rows: Array<Record<string, unknown>>) {
  return {
    storageProvider: {
      findFirst: jest.fn(async () => rows.find((r) => r.isDefault) ?? null),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        rows.find((r) => r.id === where.id) ?? null,
      ),
    },
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prov-1',
    kind: 'cloudinary',
    name: 'Primary',
    isDefault: true,
    isActive: true,
    ...overrides,
  };
}

describe('StorageRegistry', () => {
  it('builds an adapter from the default provider row', async () => {
    const reg = new StorageRegistry(prismaWith([row()]) as never, CLOUDINARY);
    const adapter = await reg.getDefault();
    expect(adapter.id).toBe('prov-1');
    expect(adapter.kind).toBe('cloudinary');
  });

  it('reads only identity columns, never stored credentials', async () => {
    // Credentials come from CLOUDINARY_* env vars. Selecting only id/kind also
    // keeps the new server working before and after the migration that drops
    // the old credential columns.
    const prisma = prismaWith([row(), row({ id: 'prov-2', isDefault: false })]);
    const reg = new StorageRegistry(prisma as never, CLOUDINARY);
    await reg.getDefault();
    await reg.get('prov-2');
    for (const call of [
      prisma.storageProvider.findFirst.mock.calls[0],
      prisma.storageProvider.findUnique.mock.calls[0],
    ]) {
      expect(call[0]).toMatchObject({ select: { id: true, kind: true } });
    }
  });

  it('caches the adapter instead of rebuilding it on every call', async () => {
    const prisma = prismaWith([row()]);
    const reg = new StorageRegistry(prisma as never, CLOUDINARY);
    await reg.getDefault();
    await reg.getDefault();
    expect(prisma.storageProvider.findFirst).toHaveBeenCalledTimes(1);
  });

  it('rebuilds the adapter after invalidation', async () => {
    const prisma = prismaWith([row()]);
    const reg = new StorageRegistry(prisma as never, CLOUDINARY);
    await reg.getDefault();
    reg.invalidate();
    await reg.getDefault();
    expect(prisma.storageProvider.findFirst).toHaveBeenCalledTimes(2);
  });

  it('throws a clear error when no default provider is configured', async () => {
    const reg = new StorageRegistry(prismaWith([]) as never, CLOUDINARY);
    await expect(reg.getDefault()).rejects.toThrow(/no default storage provider/i);
  });

  it('resolves a specific provider by id, so old files keep working', async () => {
    const rows = [row(), row({ id: 'prov-2', name: 'Old', isDefault: false })];
    const reg = new StorageRegistry(prismaWith(rows) as never, CLOUDINARY);
    const adapter = await reg.get('prov-2');
    expect(adapter.id).toBe('prov-2');
  });

  it('refuses an unsupported provider kind rather than failing silently', async () => {
    const reg = new StorageRegistry(
      prismaWith([row({ kind: 'bunny' })]) as never,
      CLOUDINARY,
    );
    await expect(reg.getDefault()).rejects.toThrow(/unsupported storage kind: bunny/i);
  });
});
