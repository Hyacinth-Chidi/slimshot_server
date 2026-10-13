import { ensureR2Default, R2_PROVIDER_NAME } from './default-storage';

interface Row {
  id: string;
  kind: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  publicConfig?: unknown;
}

/** An in-memory StorageProvider table with just the calls the seed makes. */
function tableWith(rows: Row[]) {
  const storageProvider = {
    findFirst: jest.fn(
      async ({ where }: { where: { isDefault: boolean } }) =>
        rows.find((r) => r.isDefault === where.isDefault) ?? null,
    ),
    updateMany: jest.fn(
      async ({
        where,
        data,
      }: {
        where: { isDefault: boolean; NOT?: { name: string } };
        data: Partial<Row>;
      }) => {
        const hit = rows.filter(
          (r) => r.isDefault === where.isDefault && r.name !== where.NOT?.name,
        );
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      },
    ),
    upsert: jest.fn(
      async ({
        where,
        create,
        update,
      }: {
        where: { name: string };
        create: Row;
        update: Partial<Row>;
      }) => {
        const found = rows.find((r) => r.name === where.name);
        if (found) return Object.assign(found, update);
        const row = { ...create, id: `id-${rows.length + 1}` };
        rows.push(row);
        return row;
      },
    ),
  };
  const tx = { storageProvider };
  return {
    rows,
    storageProvider,
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
}

describe('ensureR2Default', () => {
  it('creates R2 as the default on an empty database', async () => {
    const db = tableWith([]);
    expect(await ensureR2Default(db as never, 'slimshot-audio')).toBe('created');
    expect(db.rows).toEqual([
      expect.objectContaining({
        kind: 'r2',
        name: R2_PROVIDER_NAME,
        isDefault: true,
        isActive: true,
        publicConfig: { bucket: 'slimshot-audio' },
      }),
    ]);
  });

  it('switches a database that still defaults to Cloudinary over to R2', async () => {
    const db = tableWith([
      {
        id: 'old',
        kind: 'cloudinary',
        name: 'Primary Cloudinary',
        isDefault: true,
        isActive: true,
      },
    ]);
    expect(await ensureR2Default(db as never, 'slimshot-audio')).toBe('switched');

    const [old, r2] = db.rows;
    // The old row stays: files that point at it keep their history.
    expect(old).toMatchObject({ kind: 'cloudinary', isDefault: false, isActive: false });
    expect(r2).toMatchObject({ kind: 'r2', isDefault: true, isActive: true });
    expect(db.rows.filter((r) => r.isDefault)).toHaveLength(1);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it('changes nothing when R2 is already the default, so every deploy can run it', async () => {
    const db = tableWith([
      { id: 'r2', kind: 'r2', name: R2_PROVIDER_NAME, isDefault: true, isActive: true },
    ]);
    expect(await ensureR2Default(db as never, 'slimshot-audio')).toBe('unchanged');
    expect(db.storageProvider.upsert).not.toHaveBeenCalled();
    expect(db.storageProvider.updateMany).not.toHaveBeenCalled();
  });

  it('re-enables an R2 row that exists but is not the default', async () => {
    const db = tableWith([
      {
        id: 'old',
        kind: 'cloudinary',
        name: 'Primary Cloudinary',
        isDefault: true,
        isActive: true,
      },
      { id: 'r2', kind: 'r2', name: R2_PROVIDER_NAME, isDefault: false, isActive: false },
    ]);
    expect(await ensureR2Default(db as never, 'slimshot-audio')).toBe('switched');
    expect(db.rows.find((r) => r.id === 'r2')).toMatchObject({
      isDefault: true,
      isActive: true,
    });
    expect(db.rows.find((r) => r.id === 'old')).toMatchObject({ isDefault: false });
  });

  it('records no bucket when none is configured', async () => {
    const db = tableWith([]);
    await ensureR2Default(db as never, undefined);
    expect(db.rows[0].publicConfig).toBeUndefined();
  });
});
