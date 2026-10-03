import { CreditSettingsService } from './credit-settings.service';

const ROW = { id: 'default', signupBonusCredits: 100, adRewardCredits: 5, adDailyCap: 10 };

function build() {
  const prisma = {
    creditSettings: {
      findUniqueOrThrow: jest.fn(async () => ({ ...ROW })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...ROW, ...data })),
    },
  };
  const audit = { record: jest.fn(async (_entry: unknown) => undefined) };
  return { svc: new CreditSettingsService(prisma as never, audit as never), prisma, audit };
}

describe('CreditSettingsService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reads the settings row and caches it for 30 seconds', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { svc, prisma } = build();
    await svc.get();
    await svc.get();
    expect(prisma.creditSettings.findUniqueOrThrow).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_030_001);
    await svc.get();
    expect(prisma.creditSettings.findUniqueOrThrow).toHaveBeenCalledTimes(2);
  });

  it('updates, drops the cache, and audits before and after', async () => {
    const { svc, prisma, audit } = build();
    await svc.get();
    const updated = await svc.update({ adRewardCredits: 8 }, 'admin-1');
    expect(updated.adRewardCredits).toBe(8);
    expect(prisma.creditSettings.update).toHaveBeenCalledWith({
      where: { id: 'default' },
      data: { adRewardCredits: 8, updatedById: 'admin-1' },
    });
    // The first get warmed the cache and update read before from it; this get must hit the database again.
    await svc.get();
    expect(prisma.creditSettings.findUniqueOrThrow).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'credits.settings.updated', actorId: 'admin-1', actorType: 'admin' }),
    );
  });
});
