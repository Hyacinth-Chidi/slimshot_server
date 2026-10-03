import { MeService } from './me.service';

describe('MeService.view', () => {
  it('describes the account, sign-in methods and ads left today', async () => {
    const prisma = {
      user: {
        findUniqueOrThrow: jest.fn(async () => ({
          id: 'u1',
          email: 'ann@example.com',
          username: null,
          referralCode: 'AB3DEF7K',
          creditBalance: 40,
          accountStatus: 'active',
          claimedAt: null,
          googleSub: 'g-1',
        })),
      },
      creditTransaction: { count: jest.fn(async () => 3) },
    };
    const settings = { get: jest.fn(async () => ({ adRewardCredits: 5, adDailyCap: 10 })) };
    const me = new MeService(prisma as never, settings as never);

    await expect(me.view('u1', new Date('2026-10-03T12:00:00Z'))).resolves.toEqual({
      id: 'u1',
      email: 'ann@example.com',
      username: null,
      referralCode: 'AB3DEF7K',
      creditBalance: 40,
      accountStatus: 'active',
      needsClaim: true,
      signInMethods: { google: true, email: true },
      ads: { rewardCredits: 5, dailyCap: 10, remainingToday: 7 },
    });
  });
});
