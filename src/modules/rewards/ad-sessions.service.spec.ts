import { BadRequestException, HttpException } from '@nestjs/common';

import { FakeCreditDb } from '../../../test/fakes/fake-credit-db';
import { FakeRedis } from '../../../test/fakes/fake-redis';
import { LedgerService } from '../credits/ledger.service';
import { AdSessionsService } from './ad-sessions.service';
import { SsvSignatureError } from './admob-verifier';

const user = (id = 'u1', status = 'active') => ({ id, sessionId: 's1', deviceId: 'dev-1', status }) as never;

function build(opts: { cap?: number; adUnits?: string[] } = {}) {
  const db = new FakeCreditDb();
  db.addUser('u1');
  db.addUser('u2');
  const prisma = db.prisma();
  const redis = new FakeRedis();
  const settings = { get: jest.fn(async () => ({ adRewardCredits: 5, adDailyCap: opts.cap ?? 10 })) };
  const verifier = { verify: jest.fn() };
  const svc = new AdSessionsService(
    redis as never,
    prisma as never,
    new LedgerService(prisma as never),
    settings as never,
    verifier as never,
    { adUnitIds: opts.adUnits ?? ['ca-app-pub-1/2'], verifierKeysUrl: '' } as never,
  );
  const callback = (nonce: string, overrides: Record<string, string> = {}) => {
    verifier.verify.mockResolvedValueOnce({
      // AdMob sends the ad unit's number, the part after the slash in the console's ID.
      adUnit: '2',
      customData: nonce,
      userId: 'u1',
      transactionId: 'tx-1',
      rewardAmount: '1',
      timestamp: '0',
      keyId: '123',
      ...overrides,
    });
    return svc.handleCallback('raw-query');
  };
  return { svc, db, redis, verifier, callback };
}

async function errorOf(p: Promise<unknown>): Promise<HttpException> {
  return p.then(
    () => {
      throw new Error('expected a failure');
    },
    (e: HttpException) => e,
  );
}

describe('AdSessionsService.start', () => {
  it('issues a nonce for the ad and says what it pays', async () => {
    const { svc, redis } = build();
    const session = await svc.start(user());
    expect(session).toEqual({ nonce: expect.any(String), ssvUserId: 'u1', rewardCredits: 5, adsRemainingToday: 10 });
    expect(JSON.parse((await redis.get(`ad:session:${session.nonce}`)) ?? '{}')).toEqual({
      userId: 'u1',
      status: 'pending',
    });
  });

  it('refuses once the daily cap is reached, saying when it resets', async () => {
    const { svc, callback } = build({ cap: 1 });
    await callback((await svc.start(user())).nonce);
    const error = await errorOf(svc.start(user()));
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toMatchObject({ code: 'AD_DAILY_CAP_REACHED', details: { resetsAt: expect.any(String) } });
  });

  it('refuses a suspended account', async () => {
    const { svc } = build();
    expect((await errorOf(svc.start(user('u1', 'suspended')))).getResponse()).toMatchObject({ code: 'ACCOUNT_SUSPENDED' });
  });
});

describe('AdSessionsService.handleCallback', () => {
  it('grants the reward once AdMob confirms, and the poll reports it', async () => {
    const { svc, db, callback } = build();
    const { nonce } = await svc.start(user());
    await callback(nonce);
    expect(db.users.get('u1')?.creditBalance).toBe(5);
    await expect(svc.status(user(), nonce)).resolves.toEqual({ status: 'granted', credits: 5, balance: 5 });
  });

  it('grants nothing more for a repeated transaction id', async () => {
    const { svc, db, callback } = build();
    const { nonce } = await svc.start(user());
    await callback(nonce);
    await callback(nonce);
    expect(db.users.get('u1')?.creditBalance).toBe(5);
    expect(db.ledger).toHaveLength(1);
  });

  it('caps the rewards per day', async () => {
    const { svc, db, callback } = build({ cap: 1 });
    const first = await svc.start(user());
    const second = await svc.start(user());
    await callback(first.nonce, { transactionId: 'tx-1' });
    await callback(second.nonce, { transactionId: 'tx-2' });
    expect(db.users.get('u1')?.creditBalance).toBe(5);
    await expect(svc.status(user(), second.nonce)).resolves.toMatchObject({ status: 'capped' });
  });

  it('ignores a callback from an ad unit that is not ours', async () => {
    const { svc, db, callback } = build();
    const { nonce } = await svc.start(user());
    await callback(nonce, { adUnit: '9' });
    expect(db.users.get('u1')?.creditBalance).toBe(0);
    await expect(svc.status(user(), nonce)).resolves.toMatchObject({ status: 'pending' });
  });

  it('matches ad units written either way in the allowlist', async () => {
    const { svc, db, callback } = build({ adUnits: ['2'] });
    const { nonce } = await svc.start(user());
    await callback(nonce, { adUnit: 'ca-app-pub-1/2' });
    expect(db.users.get('u1')?.creditBalance).toBe(5);
  });

  it("answers AdMob's console test callback without granting anything", async () => {
    const { db, callback } = build();
    await expect(callback('', { userId: '' })).resolves.toBeUndefined();
    expect(db.ledger).toHaveLength(0);
  });

  it('rejects a callback whose user is not the one who started the session', async () => {
    const { svc, db, callback } = build();
    const { nonce } = await svc.start(user());
    await callback(nonce, { userId: 'u2' });
    expect(db.ledger).toHaveLength(0);
    await expect(svc.status(user(), nonce)).resolves.toMatchObject({ status: 'rejected' });
  });

  it('answers 400 for a bad signature', async () => {
    const { svc, verifier } = build();
    verifier.verify.mockRejectedValueOnce(new SsvSignatureError('The callback signature does not match.'));
    await expect(svc.handleCallback('raw-query')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects the reward when the account was suspended meanwhile', async () => {
    const { svc, db, callback } = build();
    const { nonce } = await svc.start(user());
    (db.users.get('u1') as { accountStatus: string }).accountStatus = 'suspended';
    await callback(nonce);
    expect(db.ledger).toHaveLength(0);
    await expect(svc.status(user(), nonce)).resolves.toMatchObject({ status: 'rejected' });
  });
});

describe('AdSessionsService.status', () => {
  it("hides another user's session", async () => {
    const { svc } = build();
    const { nonce } = await svc.start(user());
    expect((await errorOf(svc.status(user('u2'), nonce))).getStatus()).toBe(404);
  });
});
