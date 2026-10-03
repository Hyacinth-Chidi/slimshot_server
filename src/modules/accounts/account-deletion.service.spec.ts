import { HttpException } from '@nestjs/common';

import { AccountDeletionService } from './account-deletion.service';

function build(
  user: { accountStatus: string; creditBalance: number } | null = { accountStatus: 'active', creditBalance: 40 },
) {
  const tx = {
    user: {
      findUnique: jest.fn(async () => user),
      update: jest.fn(async () => undefined),
    },
    userRefreshToken: { updateMany: jest.fn(async () => ({ count: 2 })) },
    userSession: { updateMany: jest.fn(async () => ({ count: 1 })) },
    device: { updateMany: jest.fn(async () => ({ count: 1 })) },
    bonusClaim: { deleteMany: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    user: { findUnique: jest.fn(async (): Promise<{ id: string } | null> => ({ id: 'u1' })) },
  };
  const ledger = { post: jest.fn(async () => ({ replayed: false })) };
  const otp = { send: jest.fn(async () => ({})), verify: jest.fn(async () => undefined) };
  const audit = { record: jest.fn(async (_e: unknown) => undefined) };
  const limiter = { hit: jest.fn(async () => undefined) };
  const hashes = { hash: jest.fn(() => 'ip-hash') };
  const svc = new AccountDeletionService(
    prisma as never,
    ledger as never,
    otp as never,
    audit as never,
    limiter as never,
    hashes as never,
  );
  return { svc, tx, prisma, ledger, otp, audit };
}

describe('AccountDeletionService.deleteAccount', () => {
  it('forfeits credits through the ledger, ends sessions, unlinks installs and erases personal data', async () => {
    const { svc, tx, ledger, audit } = build();
    await svc.deleteAccount('u1', { type: 'user', id: 'u1' });

    expect(ledger.post).toHaveBeenCalledWith({ userId: 'u1', type: 'account_deleted', amount: -40, reference: 'u1' }, tx);
    expect(tx.userRefreshToken.updateMany).toHaveBeenCalledWith({
      where: { session: { userId: 'u1' }, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(tx.userSession.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(tx.device.updateMany).toHaveBeenCalledWith({ where: { userId: 'u1' }, data: { userId: null } });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: {
        email: null,
        googleSub: null,
        username: null,
        referralCode: null,
        phone: null,
        displayName: null,
        avatarUrl: null,
        accountStatus: 'deleted',
        deletedAt: expect.any(Date),
      },
    });
    // The anti-fraud claim records survive deletion.
    expect(tx.bonusClaim.deleteMany).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.deleted', actorType: 'user', entityId: 'u1' }),
    );
  });

  it('skips the forfeit row for an empty balance', async () => {
    const { svc, ledger } = build({ accountStatus: 'active', creditBalance: 0 });
    await svc.deleteAccount('u1', { type: 'user', id: 'u1' });
    expect(ledger.post).not.toHaveBeenCalled();
  });

  it('answers 404 for an account already deleted', async () => {
    const { svc } = build({ accountStatus: 'deleted', creditBalance: 0 });
    const error = (await svc.deleteAccount('u1', { type: 'user', id: 'u1' }).catch((e: unknown) => e)) as HttpException;
    expect(error.getStatus()).toBe(404);
  });
});

describe('AccountDeletionService on the web', () => {
  it('only emails a code when an account exists, and answers the same either way', async () => {
    const { svc, prisma, otp } = build();
    await expect(svc.requestWebDeletion(' Ann@Example.com ', '10.0.0.1')).resolves.toEqual({ sentTo: 'ann@example.com' });
    expect(otp.send).toHaveBeenCalledWith('delete_account', 'ann@example.com', { ip: '10.0.0.1' });

    prisma.user.findUnique.mockResolvedValueOnce(null);
    otp.send.mockClear();
    await expect(svc.requestWebDeletion('nobody@example.com')).resolves.toEqual({ sentTo: 'nobody@example.com' });
    expect(otp.send).not.toHaveBeenCalled();
  });

  it('answers the same when the code cannot be sent, so the answer never reveals an account', async () => {
    const { svc, otp } = build();
    otp.send.mockRejectedValueOnce(new HttpException({ code: 'OTP_RESEND_TOO_SOON', message: 'Wait.' }, 429));
    await expect(svc.requestWebDeletion('ann@example.com', '10.0.0.1')).resolves.toEqual({ sentTo: 'ann@example.com' });
    otp.send.mockRejectedValueOnce(new Error('SMTP is down'));
    await expect(svc.requestWebDeletion('ann@example.com', '10.0.0.1')).resolves.toEqual({ sentTo: 'ann@example.com' });
  });

  it('deletes after the emailed code checks out', async () => {
    const { svc, otp, tx } = build();
    await svc.confirmWebDeletion('ann@example.com', '123456');
    expect(otp.verify).toHaveBeenCalledWith('delete_account', 'ann@example.com', '123456');
    expect(tx.user.update).toHaveBeenCalled();
  });
});
