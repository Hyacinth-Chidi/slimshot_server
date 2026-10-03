import { HttpException } from '@nestjs/common';

import { PricingService } from './pricing.service';

function build(row: Record<string, unknown> | null) {
  const prisma = { pricingRule: { findFirst: jest.fn(async () => row) } };
  return { prisma, svc: new PricingService(prisma as never) };
}

describe('PricingService', () => {
  it('prices with the active rule for the feature', async () => {
    const { svc, prisma } = build({ id: 'r1', version: 2, mode: 'per_job', perJobCredits: 3, tiers: null });
    await expect(svc.price('auto_captions' as never, 10)).resolves.toMatchObject({
      credits: 3,
      rule: { id: 'r1', version: 2 },
    });
    expect(prisma.pricingRule.findFirst).toHaveBeenCalledWith({ where: { feature: 'auto_captions', isActive: true } });
  });

  it('answers 503 CAPTIONS_UNAVAILABLE when no rule is active', async () => {
    const error = (await build(null)
      .svc.price('auto_captions' as never, 10)
      .catch((e: unknown) => e)) as HttpException;
    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toMatchObject({ code: 'CAPTIONS_UNAVAILABLE' });
  });
});
