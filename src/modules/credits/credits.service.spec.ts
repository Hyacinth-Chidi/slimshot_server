import { CreditsService } from './credits.service';

function build(balance: number, rows: Array<{ id: string }> = []) {
  const prisma = {
    user: { findUniqueOrThrow: jest.fn(async () => ({ creditBalance: balance })) },
    creditTransaction: { findMany: jest.fn(async () => rows) },
  };
  const pricing = { price: jest.fn(async () => ({ credits: 6, rule: { version: 3 } })) };
  return { prisma, pricing, svc: new CreditsService(prisma as never, pricing as never) };
}

describe('CreditsService', () => {
  it.each([
    [94, true],
    [5, false],
  ])('quotes against a balance of %p (enough: %p)', async (balance, enough) => {
    await expect(build(balance).svc.quote('u1', 'auto_captions' as never, 125)).resolves.toEqual({
      credits: 6,
      balance,
      enough,
      pricingVersion: 3,
    });
  });

  it('pages the history newest first with a cursor', async () => {
    const rows = [{ id: 't3' }, { id: 't2' }, { id: 't1' }];
    const { svc, prisma } = build(0, rows);
    await expect(svc.history('u1', undefined, 2)).resolves.toEqual({ items: rows.slice(0, 2), nextCursor: 't2' });
    expect(prisma.creditTransaction.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 3,
      select: { id: true, type: true, amount: true, balanceAfter: true, createdAt: true },
    });

    await svc.history('u1', 't2', 2);
    expect(prisma.creditTransaction.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: { id: 't2' }, skip: 1 }),
    );
  });

  it('reports no next page on the last page', async () => {
    await expect(build(0, [{ id: 't1' }]).svc.history('u1', undefined, 2)).resolves.toEqual({
      items: [{ id: 't1' }],
      nextCursor: null,
    });
  });
});
