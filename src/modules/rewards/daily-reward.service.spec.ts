import { FakeCreditDb } from '../../../test/fakes/fake-credit-db';
import { LedgerService } from '../credits/ledger.service';
import { DailyRewardService } from './daily-reward.service';

const HOUR = 3_600_000;
const USER = { id: 'u1', sessionId: 's1', deviceId: 'd1', status: 'active' as const };

function build(opts: { enabled?: boolean; credits?: number; status?: 'active' | 'suspended' } = {}) {
  const db = new FakeCreditDb();
  db.addUser('u1', 10, opts.status ?? 'active');
  const settings = {
    get: jest.fn(async () => ({ dailyRewardEnabled: opts.enabled ?? true, dailyRewardCredits: opts.credits ?? 5 })),
  };
  const svc = new DailyRewardService(db.prisma() as never, settings as never, new LedgerService(db.prisma() as never));
  return { svc, db };
}

/** A claim already in the ledger, made `hoursAgo` hours ago. */
function pastClaim(db: FakeCreditDb, hoursAgo: number) {
  db.ledger.push({
    id: 'tx-old',
    userId: 'u1',
    type: 'daily_reward',
    amount: 5,
    balanceAfter: 10,
    idempotencyKey: 'daily_reward:first:u1',
    reference: 'first:u1',
    metadata: null,
    createdAt: new Date(Date.now() - hoursAgo * HOUR),
  });
}

describe('DailyRewardService.status', () => {
  it('is claimable at once by someone who never claimed', async () => {
    const { svc } = build();
    expect(await svc.status('u1')).toEqual({ enabled: true, credits: 5, nextClaimAt: null });
  });

  it('says when the next claim opens, 24 hours after the last', async () => {
    const { svc, db } = build();
    pastClaim(db, 3);
    const next = new Date(db.ledger[0].createdAt.getTime() + 24 * HOUR).toISOString();
    expect(await svc.status('u1')).toEqual({ enabled: true, credits: 5, nextClaimAt: next });
  });

  it('is claimable again once 24 hours have passed', async () => {
    const { svc, db } = build();
    pastClaim(db, 25);
    expect((await svc.status('u1')).nextClaimAt).toBeNull();
  });

  it('says when it is switched off', async () => {
    const { svc } = build({ enabled: false });
    expect(await svc.status('u1')).toEqual({ enabled: false, credits: 5, nextClaimAt: null });
  });
});

describe('DailyRewardService.claim', () => {
  it('credits the set amount through the ledger, once', async () => {
    const { svc, db } = build({ credits: 7 });

    const result = await svc.claim(USER);

    expect(db.users.get('u1')?.creditBalance).toBe(17);
    expect(db.ledger).toHaveLength(1);
    expect(db.ledger[0]).toMatchObject({ type: 'daily_reward', amount: 7, balanceAfter: 17 });
    expect(result).toEqual({
      credits: 7,
      balance: 17,
      nextClaimAt: new Date(db.ledger[0].createdAt.getTime() + 24 * HOUR).toISOString(),
    });
  });

  it('refuses a second claim within 24 hours, saying when', async () => {
    const { svc, db } = build();
    pastClaim(db, 23);
    await expect(svc.claim(USER)).rejects.toMatchObject({
      status: 409,
      response: {
        code: 'DAILY_REWARD_NOT_READY',
        details: { nextClaimAt: new Date(db.ledger[0].createdAt.getTime() + 24 * HOUR).toISOString() },
      },
    });
    expect(db.ledger).toHaveLength(1);
    expect(db.users.get('u1')?.creditBalance).toBe(10);
  });

  it('pays again 24 hours after the last claim', async () => {
    const { svc, db } = build();
    pastClaim(db, 24.01);
    await svc.claim(USER);
    expect(db.ledger).toHaveLength(2);
    expect(db.users.get('u1')?.creditBalance).toBe(15);
  });

  it('pays once when two claims arrive together', async () => {
    const { svc, db } = build();

    const results = await Promise.allSettled([svc.claim(USER), svc.claim(USER)]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ status: 409, response: { code: 'DAILY_REWARD_NOT_READY' } });
    expect(db.ledger).toHaveLength(1);
    expect(db.users.get('u1')?.creditBalance).toBe(15);
  });

  it('pays nothing while switched off', async () => {
    const { svc, db } = build({ enabled: false });
    await expect(svc.claim(USER)).rejects.toMatchObject({
      status: 409,
      response: { code: 'DAILY_REWARD_OFF', message: 'Daily credits are switched off.' },
    });
    expect(db.ledger).toHaveLength(0);
  });

  it('pays nothing to a suspended account', async () => {
    const { svc, db } = build({ status: 'suspended' });
    await expect(svc.claim({ ...USER, status: 'suspended' as never })).rejects.toMatchObject({
      status: 403,
      response: { code: 'ACCOUNT_SUSPENDED' },
    });
    expect(db.ledger).toHaveLength(0);
  });
});
