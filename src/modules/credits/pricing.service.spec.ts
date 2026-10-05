import { HttpException } from '@nestjs/common';

import { PricingService } from './pricing.service';

interface RuleRow {
  id: string;
  feature: string;
  version: number;
  mode: string;
  perJobCredits: number | null;
  tiers: unknown;
  isActive: boolean;
}

function build(rows: RuleRow[] = []) {
  const prisma = {
    pricingRule: {
      findFirst: jest.fn(async ({ where }: { where: { feature: string; isActive?: boolean } }) => {
        const matches = rows.filter((r) => r.feature === where.feature && (where.isActive === undefined || r.isActive === where.isActive));
        return matches.sort((a, b) => b.version - a.version)[0] ?? null;
      }),
      findMany: jest.fn(async () => [...rows].sort((a, b) => b.version - a.version)),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null),
      create: jest.fn(async ({ data }: { data: Partial<RuleRow> }) => {
        const row = { id: `r${rows.length + 1}`, isActive: false, perJobCredits: null, tiers: null, ...data } as RuleRow;
        rows.push(row);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: { feature: string; isActive: boolean }; data: Partial<RuleRow> }) => {
        const hit = rows.filter((r) => r.feature === where.feature && r.isActive === where.isActive);
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<RuleRow> }) =>
        Object.assign(rows.find((r) => r.id === where.id) as RuleRow, data),
      ),
    },
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const audit = { record: jest.fn(async (_e: unknown) => undefined) };
  return { prisma, audit, rows, svc: new PricingService(prisma as never, audit as never) };
}

const rule = (o: Partial<RuleRow>): RuleRow => ({
  id: 'r1',
  feature: 'auto_captions',
  version: 1,
  mode: 'per_job',
  perJobCredits: 3,
  tiers: null,
  isActive: true,
  ...o,
});

async function errorOf(p: Promise<unknown>): Promise<HttpException> {
  return p.then(
    () => {
      throw new Error('expected a failure');
    },
    (e: HttpException) => e,
  );
}

describe('PricingService.price', () => {
  it('prices with the active rule for the feature', async () => {
    const { svc, prisma } = build([rule({ version: 2 })]);
    await expect(svc.price('auto_captions' as never, 10)).resolves.toMatchObject({
      credits: 3,
      rule: { id: 'r1', version: 2 },
    });
    expect(prisma.pricingRule.findFirst).toHaveBeenCalledWith({ where: { feature: 'auto_captions', isActive: true } });
  });

  it('answers 503 CAPTIONS_UNAVAILABLE when no rule is active', async () => {
    const error = await errorOf(build().svc.price('auto_captions' as never, 10));
    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toMatchObject({ code: 'CAPTIONS_UNAVAILABLE' });
  });
});

describe('PricingService admin', () => {
  const tiers = [
    { upToSeconds: 60, credits: 2 },
    { upToSeconds: null, credits: 5 },
  ];

  it('creates the next version of a feature and audits it', async () => {
    const { svc, prisma, audit } = build([rule({ version: 4 })]);
    const created = await svc.createRule({ feature: 'auto_captions' as never, mode: 'duration_tiers' as never, tiers }, 'admin-1');
    expect(created).toMatchObject({ version: 5, isActive: false });
    expect(prisma.pricingRule.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ feature: 'auto_captions', version: 5, mode: 'duration_tiers', tiers, createdById: 'admin-1' }),
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'pricing.rule.created', actorId: 'admin-1' }));
  });

  it('refuses invalid tiers with the problems listed', async () => {
    const error = await errorOf(
      build().svc.createRule(
        { feature: 'auto_captions' as never, mode: 'duration_tiers' as never, tiers: [{ upToSeconds: 60, credits: 2 }] },
        'admin-1',
      ),
    );
    expect(error.getStatus()).toBe(422);
    expect(error.getResponse()).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { problems: [expect.stringContaining('open-ended')] },
    });
  });

  it('refuses a per-job rule without a price', async () => {
    const error = await errorOf(build().svc.createRule({ feature: 'auto_captions' as never, mode: 'per_job' as never }, 'admin-1'));
    expect(error.getStatus()).toBe(422);
  });

  it('stores a by-the-second rule with its block rate and minimum, and nothing else', async () => {
    const { svc, prisma } = build();
    await svc.createRule(
      { feature: 'auto_captions' as never, mode: 'per_second' as never, blockSeconds: 10, blockCredits: 1, minCredits: 2 },
      'admin-1',
    );
    expect(prisma.pricingRule.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        mode: 'per_second',
        blockSeconds: 10,
        blockCredits: 1,
        minCredits: 2,
        perJobCredits: null,
      }),
    });
  });

  it('stores no block rate on a per-job rule', async () => {
    const { svc, prisma } = build();
    await svc.createRule(
      { feature: 'auto_captions' as never, mode: 'per_job' as never, perJobCredits: 3, blockSeconds: 10 },
      'admin-1',
    );
    expect(prisma.pricingRule.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ perJobCredits: 3, blockSeconds: null, blockCredits: null, minCredits: null }),
    });
  });

  it('refuses a by-the-second rule without a block length', async () => {
    const error = await errorOf(
      build().svc.createRule({ feature: 'auto_captions' as never, mode: 'per_second' as never, blockCredits: 1 }, 'admin-1'),
    );
    expect(error.getStatus()).toBe(422);
    expect(error.getResponse()).toMatchObject({
      details: { problems: [expect.stringContaining('blockSeconds')] },
    });
  });

  it('activates a rule and switches the old one off in one transaction', async () => {
    const { svc, rows, prisma, audit } = build([rule({ id: 'r1', isActive: true }), rule({ id: 'r2', version: 2, isActive: false })]);
    await svc.activate('r2', 'admin-1');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(rows.find((r) => r.id === 'r1')?.isActive).toBe(false);
    expect(rows.find((r) => r.id === 'r2')?.isActive).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'pricing.rule.activated', entityId: 'r2' }));
  });

  it('does nothing for a rule that is already active', async () => {
    const { svc, prisma, audit } = build([rule({ id: 'r1', isActive: true })]);
    await svc.activate('r1', 'admin-1');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown rule', async () => {
    expect((await errorOf(build().svc.activate('nope', 'admin-1'))).getStatus()).toBe(404);
  });
});
