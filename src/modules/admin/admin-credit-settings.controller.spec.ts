import { AdminCreditSettingsController } from './admin-credit-settings.controller';

const ROW = { id: 'default', signupBonusCredits: 100, adRewardCredits: 5 };
const CHANGE = {
  id: 'e1',
  actorId: 'admin-1',
  createdAt: new Date('2026-10-27T10:00:00Z'),
  before: { adRewardCredits: 5 },
  after: { adRewardCredits: 6 },
};

function build() {
  const order: string[] = [];
  const settings = {
    get: jest.fn(async () => ({ ...ROW })),
    update: jest.fn(async (patch: Record<string, unknown>) => {
      order.push('update');
      return { ...ROW, ...patch };
    }),
  };
  const prisma = {
    auditLog: {
      findMany: jest.fn(async ({ cursor }: { cursor?: unknown }) => {
        order.push('history');
        return cursor ? [] : [CHANGE];
      }),
    },
    adminUser: { findMany: jest.fn(async () => [{ id: 'admin-1', email: 'owner@slimshot.dev', name: 'Owner' }]) },
  };
  return { ctl: new AdminCreditSettingsController(settings as never, prisma as never), order };
}

const OWNER = { id: 'admin-1', email: 'owner@slimshot.dev', name: 'Owner' };

describe('AdminCreditSettingsController', () => {
  it('returns the settings with when each field last changed', async () => {
    const res = await build().ctl.get();
    expect(res.data).toMatchObject(ROW);
    expect(res.data.lastChanged).toEqual({ adRewardCredits: { at: CHANGE.createdAt, by: OWNER } });
  });

  it('reads the history after saving, so the save just made counts', async () => {
    const { ctl, order } = build();
    const res = await ctl.update({ adRewardCredits: 6 } as never, { sub: 'admin-1' } as never);
    expect(res.data.adRewardCredits).toBe(6);
    expect(res.data.lastChanged.adRewardCredits?.by).toEqual(OWNER);
    expect(order[0]).toBe('update');
  });
});
