import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { configureHttp } from '../../app.setup';
import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { PricingService } from '../credits/pricing.service';
import { AdminPricingRulesController } from './admin-pricing-rules.controller';

const pass = {
  canActivate(ctx: { switchToHttp: () => { getRequest: () => { user?: unknown } } }) {
    ctx.switchToHttp().getRequest().user = { sub: 'admin-1', email: 'o@example.com', role: 'owner' };
    return true;
  },
};

describe('admin pricing rules API over HTTP', () => {
  let app: INestApplication;
  let base: string;
  const pricing = {
    listRules: jest.fn(async () => []),
    createRule: jest.fn(async () => ({ id: 'r1', version: 1 })),
    activate: jest.fn(async () => []),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminPricingRulesController],
      providers: [{ provide: PricingService, useValue: pricing }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(pass)
      .overrideGuard(PermissionsGuard)
      .useValue(pass)
      .compile();
    app = moduleRef.createNestApplication();
    configureHttp(app);
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/api/admin/v1/pricing-rules`;
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (body: unknown) =>
    fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('creates a tiered rule whose last tier is open-ended', async () => {
    const tiers = [
      { upToSeconds: 60, credits: 2 },
      { upToSeconds: null, credits: 5 },
    ];
    const res = await post({ feature: 'auto_captions', mode: 'duration_tiers', tiers });
    expect(res.status).toBe(201);
    expect(pricing.createRule).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'auto_captions', mode: 'duration_tiers', tiers }),
      'admin-1',
    );
  });

  it('creates a by-the-second rule with its block rate and minimum', async () => {
    const res = await post({ feature: 'auto_captions', mode: 'per_second', blockSeconds: 10, blockCredits: 1, minCredits: 2 });
    expect(res.status).toBe(201);
    expect(pricing.createRule).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: 'per_second', blockSeconds: 10, blockCredits: 1, minCredits: 2 }),
      'admin-1',
    );
  });

  it.each([
    [{ feature: 'auto_captions', mode: 'duration_tiers', tiers: [{ upToSeconds: 0, credits: 2 }] }],
    [{ feature: 'auto_captions', mode: 'monthly' }],
    [{ feature: 'nope', mode: 'per_job', perJobCredits: 2 }],
    [{ feature: 'auto_captions', mode: 'per_second', blockSeconds: 0, blockCredits: 1 }],
    [{ feature: 'auto_captions', mode: 'per_second', blockSeconds: 10, blockCredits: 1.5 }],
    [{ feature: 'auto_captions', mode: 'per_second', blockSeconds: 10, blockCredits: 1, minCredits: -1 }],
  ])('422s an invalid rule %j', async (body) => {
    expect((await post(body)).status).toBe(422);
  });

  it('422s listing an unknown feature', async () => {
    expect((await fetch(`${base}?feature=nope`)).status).toBe(422);
  });

  it('activates with 200', async () => {
    expect((await fetch(`${base}/r1/activate`, { method: 'POST' })).status).toBe(200);
    expect(pricing.activate).toHaveBeenCalledWith('r1', 'admin-1');
  });
});
