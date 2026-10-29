import { labelEntities } from './audit-labels';

type Row = Record<string, unknown> & { id: string };

function table(rows: Row[]) {
  return {
    findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
      rows.filter((r) => where.id.in.includes(r.id)),
    ),
  };
}

function build() {
  return {
    asset: table([
      { id: 'a1', title: 'UI Button Click', deletedAt: null },
      { id: 'a2', title: 'Cartoon Boing', deletedAt: new Date('2026-10-20T00:00:00Z') },
    ]),
    user: table([
      { id: 'u1', username: 'amaka_edits', email: 'amaka@x.com', accountStatus: 'active' },
      { id: 'u2', username: null, email: 'k@x.com', accountStatus: 'active' },
      { id: 'u3', username: null, email: null, accountStatus: 'deleted' },
    ]),
    category: table([{ id: 'c1', name: 'Whoosh' }]),
    pricingRule: table([{ id: 'p3', version: 3 }]),
    providerCredential: table([{ id: 'k1', provider: 'deepgram' }]),
    adminUser: table([{ id: 'adm2', email: 'editor@slimshot.dev', deletedAt: null }]),
  };
}

const key = (entityType: string, entityId: string) => ({ entityType, entityId });

describe('labelEntities', () => {
  it('labels each type by its rule', async () => {
    const labels = await labelEntities(build() as never, [
      key('Asset', 'a1'),
      key('User', 'u1'),
      key('User', 'u2'),
      key('Category', 'c1'),
      key('PricingRule', 'p3'),
      key('ProviderCredential', 'k1'),
      key('AdminUser', 'adm2'),
      key('CreditSettings', 'default'),
      key('FontOrder', 'fonts'),
    ]);

    expect(labels.get('Asset:a1')).toEqual({ label: 'UI Button Click', deleted: false });
    expect(labels.get('User:u1')).toEqual({ label: 'amaka_edits', deleted: false });
    expect(labels.get('User:u2')).toEqual({ label: 'k@x.com', deleted: false });
    expect(labels.get('Category:c1')).toEqual({ label: 'Whoosh', deleted: false });
    expect(labels.get('PricingRule:p3')).toEqual({ label: 'v3', deleted: false });
    expect(labels.get('ProviderCredential:k1')).toEqual({ label: 'Deepgram', deleted: false });
    expect(labels.get('AdminUser:adm2')).toEqual({ label: 'editor@slimshot.dev', deleted: false });
    expect(labels.get('CreditSettings:default')).toEqual({ label: null, deleted: false });
    expect(labels.get('FontOrder:fonts')).toEqual({ label: null, deleted: false });
  });

  it("keeps a deleted sound's title and marks it deleted", async () => {
    const labels = await labelEntities(build() as never, [key('Asset', 'a2')]);
    expect(labels.get('Asset:a2')).toEqual({ label: 'Cartoon Boing', deleted: true });
  });

  it('gives a scrubbed user no label', async () => {
    const labels = await labelEntities(build() as never, [key('User', 'u3')]);
    expect(labels.get('User:u3')).toEqual({ label: null, deleted: true });
  });

  it('marks things removed outright as deleted, with no label', async () => {
    const labels = await labelEntities(build() as never, [
      key('Category', 'gone'),
      key('User', 'gone'),
      key('ProviderCredential', 'gone'),
      key('Asset', 'gone'),
    ]);
    expect(labels.get('Category:gone')).toEqual({ label: null, deleted: true });
    expect(labels.get('User:gone')).toEqual({ label: null, deleted: true });
    expect(labels.get('ProviderCredential:gone')).toEqual({ label: null, deleted: true });
    expect(labels.get('Asset:gone')).toEqual({ label: null, deleted: false });
  });

  it('makes one query per type present and none for absent types', async () => {
    const prisma = build();
    const rows = [
      ...Array.from({ length: 60 }, () => key('Asset', 'a1')),
      ...Array.from({ length: 30 }, () => key('User', 'u1')),
      ...Array.from({ length: 10 }, () => key('CreditSettings', 'default')),
    ];
    await labelEntities(prisma as never, rows);

    expect(prisma.asset.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.asset.findMany.mock.calls[0][0].where).toEqual({ id: { in: ['a1'] } });
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.category.findMany).not.toHaveBeenCalled();
    expect(prisma.pricingRule.findMany).not.toHaveBeenCalled();
    expect(prisma.providerCredential.findMany).not.toHaveBeenCalled();
    expect(prisma.adminUser.findMany).not.toHaveBeenCalled();
  });

  it('skips rows without an entity id', async () => {
    const prisma = build();
    const labels = await labelEntities(prisma as never, [{ entityType: 'Asset', entityId: null }]);
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
    expect(labels.size).toBe(0);
  });
});
