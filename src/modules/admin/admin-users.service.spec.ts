import { HttpException } from '@nestjs/common';

import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { AdminUsersService } from './admin-users.service';

const user = {
  id: 'u1',
  email: 'ada@example.com',
  username: 'ada',
  accountStatus: 'active',
  creditBalance: 12,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  claimedAt: null,
  referralCode: 'ADA123',
  deletedAt: null,
  googleSub: 'g-1',
};

function build(found: Record<string, unknown> | null = user) {
  const prisma = {
    user: {
      findMany: jest.fn(async (_args: unknown) => [] as unknown[]),
      findUnique: jest.fn(async (_args: unknown) => found),
      updateMany: jest.fn(async (_args: unknown) => ({ count: 1 })),
    },
    $queryRaw: jest.fn(async (..._args: unknown[]) => [] as unknown[]),
  };
  const ledger = { post: jest.fn(async (_input: unknown) => ({ transaction: { balanceAfter: 17 }, replayed: false })) };
  const credits = { history: jest.fn(async () => ({ items: [], nextCursor: null })) };
  const deletion = { deleteAccount: jest.fn(async () => undefined) };
  const audit = { record: jest.fn(async (_e: unknown) => undefined) };
  const svc = new AdminUsersService(prisma as never, ledger as never, credits as never, deletion as never, audit as never);
  return { svc, prisma, ledger, credits, deletion, audit };
}

async function errorOf(p: Promise<unknown>): Promise<HttpException> {
  return p.then(
    () => {
      throw new Error('expected a failure');
    },
    (e: HttpException) => e,
  );
}

describe('AdminUsersService', () => {
  it('searches email and username, newest first, one page at a time', async () => {
    const { svc, prisma } = build();
    prisma.user.findMany.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const page = await svc.search(' Ada ', 'cur', 2);
    expect(page).toEqual({ items: [{ id: 'a' }, { id: 'b' }], nextCursor: 'b' });
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { email: { contains: 'ada', mode: 'insensitive' } },
            { username: { contains: 'ada', mode: 'insensitive' } },
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 3,
        cursor: { id: 'cur' },
        skip: 1,
      }),
    );
  });

  it('lists everyone when there is no search term', async () => {
    const { svc, prisma } = build();
    await svc.search(undefined);
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {}, take: 21 }));
  });

  it('shows a user with their sign-in methods but never the Google subject', async () => {
    const detail = await build().svc.detail('u1');
    expect(detail).toMatchObject({ id: 'u1', referralCode: 'ADA123', signInMethods: { google: true, email: true } });
    expect(detail).not.toHaveProperty('googleSub');
  });

  it('answers 404 for an unknown user', async () => {
    expect((await errorOf(build(null).svc.detail('nope'))).getStatus()).toBe(404);
  });

  it('posts an adjustment with a fresh reference and audits it', async () => {
    const { svc, ledger, audit } = build();
    await expect(svc.adjust('u1', 5, 'Goodwill', 'admin-1')).resolves.toEqual({ balance: 17 });
    expect(ledger.post).toHaveBeenCalledWith({
      userId: 'u1',
      type: 'admin_adjustment',
      amount: 5,
      reference: expect.stringMatching(/^[0-9a-f-]{36}$/),
      metadata: { reason: 'Goodwill', adminId: 'admin-1' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'credits.adjusted', entityId: 'u1', after: { amount: 5, reason: 'Goodwill' } }),
    );
  });

  it('refuses an adjustment below zero with 422 and the balance', async () => {
    const { svc, ledger, audit } = build();
    ledger.post.mockRejectedValueOnce(
      appError(402, ErrorCode.INSUFFICIENT_CREDITS, 'Not enough credits.', { required: 50, balance: 12 }),
    );
    const error = await errorOf(svc.adjust('u1', -50, 'Chargeback', 'admin-1'));
    expect(error.getStatus()).toBe(422);
    expect(error.getResponse()).toMatchObject({ code: 'VALIDATION_FAILED', details: { balance: 12 } });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('suspends an active user and audits the reason', async () => {
    const { svc, prisma, audit } = build();
    await svc.suspend('u1', 'Abuse', 'admin-1');
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'u1', accountStatus: 'active' },
      data: { accountStatus: 'suspended' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.suspended', entityId: 'u1', after: { reason: 'Abuse' } }),
    );
  });

  it('answers 409 when suspending someone who is not active', async () => {
    const { svc, prisma, audit } = build({ ...user, accountStatus: 'suspended' });
    prisma.user.updateMany.mockResolvedValueOnce({ count: 0 });
    expect((await errorOf(svc.suspend('u1', 'Abuse', 'admin-1'))).getStatus()).toBe(409);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('answers 404 when suspending an unknown user', async () => {
    const { svc, prisma } = build(null);
    prisma.user.updateMany.mockResolvedValueOnce({ count: 0 });
    expect((await errorOf(svc.suspend('nope', 'Abuse', 'admin-1'))).getStatus()).toBe(404);
  });

  it('unsuspends only a suspended user', async () => {
    const { svc, prisma, audit } = build();
    await svc.unsuspend('u1', 'admin-1');
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'u1', accountStatus: 'suspended' },
      data: { accountStatus: 'active' },
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.unsuspended' }));

    prisma.user.updateMany.mockResolvedValueOnce({ count: 0 });
    expect((await errorOf(svc.unsuspend('u1', 'admin-1'))).getStatus()).toBe(409);
  });

  it('deletes through the account deletion service as the admin', async () => {
    const { svc, deletion } = build();
    await svc.remove('u1', 'User asked by email', 'admin-1');
    expect(deletion.deleteAccount).toHaveBeenCalledWith('u1', { type: 'admin', id: 'admin-1', reason: 'User asked by email' });
  });

  it('reports credits granted and spent per day and type as numbers', async () => {
    const { svc, prisma } = build();
    prisma.$queryRaw.mockResolvedValueOnce([{ day: '2026-10-01', type: 'rewarded_ad', granted: 10n, spent: 0n }]);
    await expect(svc.creditStats(7)).resolves.toEqual([{ day: '2026-10-01', type: 'rewarded_ad', granted: 10, spent: 0 }]);
  });
});
