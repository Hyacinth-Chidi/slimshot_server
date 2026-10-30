import { BadRequestException, ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { configureHttp } from '../../app.setup';
import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { UserAuthGuard } from '../accounts/user-auth.guard';
import { AdSessionsService } from './ad-sessions.service';
import { DailyRewardService } from './daily-reward.service';
import { RewardsController } from './rewards.controller';

const ACCESS = 'Bearer a.b.c';
const fakeGuard = {
  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string>; appUser?: unknown }>();
    if (req.headers.authorization !== ACCESS) {
      throw appError(401, ErrorCode.SIGN_IN_REQUIRED, 'Sign in to use this feature.');
    }
    req.appUser = { id: 'u1', sessionId: 's1', deviceId: 'dev-1', status: 'active' };
    return true;
  },
};

describe('rewards API over HTTP', () => {
  let app: INestApplication;
  let base: string;
  const sessions = {
    start: jest.fn(async () => ({ nonce: 'n1', ssvUserId: 'u1', rewardCredits: 5, adsRemainingToday: 10 })),
    status: jest.fn(),
    handleCallback: jest.fn(async () => undefined),
  };
  const daily = {
    status: jest.fn(async () => ({ enabled: true, credits: 5, nextClaimAt: null })),
    claim: jest.fn(async () => ({ credits: 5, balance: 15, nextClaimAt: '2026-10-31T09:00:00.000Z' })),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RewardsController],
      providers: [
        { provide: AdSessionsService, useValue: sessions },
        { provide: DailyRewardService, useValue: daily },
      ],
    })
      .overrideGuard(UserAuthGuard)
      .useValue(fakeGuard)
      .compile();
    app = moduleRef.createNestApplication();
    configureHttp(app);
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/api/app/v1/rewards`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('tells a signed-in user whether daily credits can be claimed', async () => {
    expect((await fetch(`${base}/daily`)).status).toBe(401);
    const res = await fetch(`${base}/daily`, { headers: { authorization: ACCESS } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { enabled: true, credits: 5, nextClaimAt: null } });
    expect(daily.status).toHaveBeenLastCalledWith('u1');
  });

  it('claims daily credits for a signed-in user only, and passes on why not', async () => {
    expect((await fetch(`${base}/daily/claim`, { method: 'POST' })).status).toBe(401);
    const res = await fetch(`${base}/daily/claim`, { method: 'POST', headers: { authorization: ACCESS } });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ credits: 5, balance: 15, nextClaimAt: '2026-10-31T09:00:00.000Z' });
    expect(daily.claim).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'u1' }));

    daily.claim.mockRejectedValueOnce(
      appError(409, ErrorCode.DAILY_REWARD_NOT_READY, 'Your daily credits are not ready yet.', {
        nextClaimAt: '2026-10-31T09:00:00.000Z',
      }),
    );
    const early = await fetch(`${base}/daily/claim`, { method: 'POST', headers: { authorization: ACCESS } });
    expect(early.status).toBe(409);
    expect((await early.json()).error).toMatchObject({
      code: 'DAILY_REWARD_NOT_READY',
      details: { nextClaimAt: '2026-10-31T09:00:00.000Z' },
    });
  });

  it('starts a session for a signed-in user only', async () => {
    expect((await fetch(`${base}/ads/session`, { method: 'POST' })).status).toBe(401);
    const res = await fetch(`${base}/ads/session`, { method: 'POST', headers: { authorization: ACCESS } });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ nonce: 'n1' });
  });

  it('passes the AdMob callback query through untouched, without sign-in', async () => {
    const query = 'ad_unit=ca-app-pub-1%2F2&custom_data=a%2Bb&signature=MEUC_x&key_id=123';
    const res = await fetch(`${base}/admob/ssv?${query}`);
    expect(res.status).toBe(200);
    expect(sessions.handleCallback).toHaveBeenCalledWith(query);
  });

  it('answers 400 when the service rejects the signature', async () => {
    sessions.handleCallback.mockRejectedValueOnce(new BadRequestException('The callback signature does not match.'));
    expect((await fetch(`${base}/admob/ssv?x=1&signature=s&key_id=1`)).status).toBe(400);
  });
});
