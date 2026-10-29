import { adminsById } from './admin-directory';

const ROWS = [
  { id: 'a1', email: 'owner@slimshot.dev', name: 'Owner', deletedAt: null },
  { id: 'a2', email: 'old@slimshot.dev', name: 'Old Admin', deletedAt: new Date('2026-10-01T00:00:00Z') },
];

function build() {
  const prisma = {
    adminUser: {
      findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        ROWS.filter((r) => where.id.in.includes(r.id)).map(({ id, email, name }) => ({ id, email, name })),
      ),
    },
  };
  return prisma;
}

describe('adminsById', () => {
  it('resolves each distinct id once, in one query', async () => {
    const prisma = build();
    const map = await adminsById(prisma as never, ['a1', 'a2', 'a1', null, undefined]);

    expect(prisma.adminUser.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.adminUser.findMany.mock.calls[0][0].where).toEqual({ id: { in: ['a1', 'a2'] } });
    expect(map.get('a1')).toEqual({ id: 'a1', email: 'owner@slimshot.dev', name: 'Owner' });
  });

  it('still names a soft-deleted admin', async () => {
    const prisma = build();
    const map = await adminsById(prisma as never, ['a2']);

    expect(map.get('a2')?.email).toBe('old@slimshot.dev');
    // No deletedAt filter: the history happened, so the name stays.
    expect(prisma.adminUser.findMany.mock.calls[0][0].where).not.toHaveProperty('deletedAt');
  });

  it('leaves out an id with no admin row', async () => {
    const map = await adminsById(build() as never, ['gone']);
    expect(map.has('gone')).toBe(false);
  });

  it('makes no query when there is nothing to resolve', async () => {
    const prisma = build();
    const map = await adminsById(prisma as never, [null, undefined]);

    expect(prisma.adminUser.findMany).not.toHaveBeenCalled();
    expect(map.size).toBe(0);
  });
});
