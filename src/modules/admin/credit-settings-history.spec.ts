import { CREDIT_SETTING_FIELDS, lastChangedByField } from './credit-settings-history';

interface Entry {
  id: string;
  actorId: string | null;
  createdAt: Date;
  before: unknown;
  after: unknown;
}

const ALL_FIELDS: Record<string, unknown> = {
  signupBonusCredits: 100,
  adRewardCredits: 5,
  adDailyCap: 10,
  referralInviterCredits: 20,
  referralInviteeCredits: 20,
  referralCapCount: 10,
  referralCapDays: 30,
  ipSignupLimitPer24h: 3,
  otpMaxAttempts: 5,
  otpResendCooldownSeconds: 60,
  otpPerEmailPerHour: 5,
  otpPerDevicePerHour: 10,
  otpPerIpPerHour: 20,
  disposableEmailDomains: ['a.com', 'b.com'],
  dailyRewardEnabled: false,
  dailyRewardCredits: 5,
  dailyRewardIntervalDays: 1,
};

const at = (day: number) => new Date(Date.UTC(2026, 9, day, 10));

/** One audit entry changing `changes` on top of the default row; entries are given newest first. */
function entry(id: string, day: number, changes: Record<string, unknown>, actorId: string | null = 'admin-1'): Entry {
  return { id, actorId, createdAt: at(day), before: { ...ALL_FIELDS }, after: { ...ALL_FIELDS, ...changes } };
}

function build(entries: Entry[]) {
  const takes: number[] = [];
  const prisma = {
    auditLog: {
      findMany: jest.fn(async (args: { take: number; cursor?: { id: string }; skip?: number; where: unknown }) => {
        takes.push(args.take);
        const start = args.cursor ? entries.findIndex((e) => e.id === args.cursor!.id) + (args.skip ?? 0) : 0;
        return entries.slice(start, start + args.take);
      }),
    },
    adminUser: {
      findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        [{ id: 'admin-1', email: 'owner@slimshot.dev', name: 'Owner' }].filter((a) => where.id.in.includes(a.id)),
      ),
    },
  };
  return { prisma, takes };
}

describe('lastChangedByField', () => {
  it('covers every field the dashboard can edit', () => {
    expect([...CREDIT_SETTING_FIELDS].sort()).toEqual(Object.keys(ALL_FIELDS).sort());
  });

  it('reads only credit settings changes, newest first, by the indexed entity', async () => {
    const { prisma } = build([]);
    await lastChangedByField(prisma as never);
    expect(prisma.auditLog.findMany.mock.calls[0][0]).toMatchObject({
      // (entityType, entityId) is indexed; action alone is not.
      where: { entityType: 'CreditSettings', entityId: 'default', action: 'credits.settings.updated' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  });

  it('stops when a page comes back short, even with fields never changed', async () => {
    const { prisma } = build([entry('e1', 20, { signupBonusCredits: 150 })]);
    await lastChangedByField(prisma as never);
    expect(prisma.auditLog.findMany).toHaveBeenCalledTimes(1);
  });

  it('takes the newest change of each field', async () => {
    const { prisma } = build([entry('e2', 27, { adRewardCredits: 6 }), entry('e1', 12, { adRewardCredits: 4 })]);
    const result = await lastChangedByField(prisma as never);
    expect(result.adRewardCredits?.at).toEqual(at(27));
  });

  it('reports only the fields an entry actually changed', async () => {
    const { prisma } = build([entry('e1', 20, { signupBonusCredits: 150 })]);
    const result = await lastChangedByField(prisma as never);
    expect(Object.keys(result)).toEqual(['signupBonusCredits']);
  });

  it('treats a reordered domain list as a change, an identical one not', async () => {
    const reordered = build([entry('e1', 20, { disposableEmailDomains: ['b.com', 'a.com'] })]);
    expect((await lastChangedByField(reordered.prisma as never)).disposableEmailDomains?.at).toEqual(at(20));

    const same = build([entry('e1', 20, { disposableEmailDomains: ['a.com', 'b.com'] })]);
    expect((await lastChangedByField(same.prisma as never)).disposableEmailDomains).toBeUndefined();
  });

  it('skips entries with no before, or a field missing from after', async () => {
    const noBefore: Entry = { id: 'e2', actorId: 'admin-1', createdAt: at(25), before: null, after: { adDailyCap: 99 } };
    const partial: Entry = { id: 'e1', actorId: 'admin-1', createdAt: at(24), before: { ...ALL_FIELDS }, after: { signupBonusCredits: 100 } };
    const { prisma } = build([noBefore, partial]);
    expect(await lastChangedByField(prisma as never)).toEqual({});
  });

  it('stops reading once every field is found', async () => {
    const everything = Object.fromEntries(
      Object.entries(ALL_FIELDS).map(([k, v]) => [k, Array.isArray(v) ? ['z.com'] : (v as number) + 1]),
    );
    const { prisma } = build([entry('e1', 28, everything), ...Array.from({ length: 300 }, (_, i) => entry(`old${i}`, 1, { adDailyCap: i }))]);
    await lastChangedByField(prisma as never);
    expect(prisma.auditLog.findMany).toHaveBeenCalledTimes(1);
  });

  it('reads at most maxEntries entries', async () => {
    const irrelevant = Array.from({ length: 5 }, (_, i) => entry(`e${i}`, 20 - i, {}));
    const { prisma, takes } = build(irrelevant);
    await lastChangedByField(prisma as never, 3);
    expect(takes.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('pages through older entries until a field is found', async () => {
    const entries = [
      ...Array.from({ length: 250 }, (_, i) => entry(`n${i}`, 28, {})),
      entry('old', 2, { referralCapDays: 60 }),
    ];
    const { prisma } = build(entries);
    expect((await lastChangedByField(prisma as never)).referralCapDays?.at).toEqual(at(2));
    expect(prisma.auditLog.findMany.mock.calls[1][0]).toMatchObject({ cursor: { id: 'n199' }, skip: 1 });
  });

  it('names the admin with one lookup, and leaves an unknown one null', async () => {
    const { prisma } = build([
      entry('e2', 27, { adRewardCredits: 6 }, 'admin-1'),
      entry('e1', 26, { adDailyCap: 12 }, 'gone'),
    ]);
    const result = await lastChangedByField(prisma as never);
    expect(prisma.adminUser.findMany).toHaveBeenCalledTimes(1);
    expect(result.adRewardCredits?.by).toEqual({ id: 'admin-1', email: 'owner@slimshot.dev', name: 'Owner' });
    expect(result.adDailyCap?.by).toBeNull();
  });
});
