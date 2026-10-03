import { HttpException } from '@nestjs/common';

import { ClaimService } from './claim.service';

const user = (status = 'active') => ({ id: 'u1', sessionId: 's1', deviceId: 'dev-1', status }) as never;

function build(claimedAt: Date | null = null) {
  const prisma = {
    user: {
      findUniqueOrThrow: jest.fn(async () => ({ claimedAt })),
      updateMany: jest.fn(async () => ({ count: claimedAt ? 0 : 1 })),
    },
  };
  const usernames = { assertAvailable: jest.fn(async (raw: string) => raw.trim().toLowerCase()) };
  const me = { view: jest.fn(async () => ({ id: 'u1', username: 'ann_1' })) };
  return { prisma, usernames, svc: new ClaimService(prisma as never, usernames as never, me as never) };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => 'passed',
    (e: HttpException) => (e.getResponse() as { code: string }).code,
  );
}

describe('ClaimService (milestone 1)', () => {
  it('sets the username and marks the account claimed', async () => {
    const { svc, prisma } = build();
    await expect(svc.claim(user(), { username: ' Ann_1 ' })).resolves.toEqual({
      user: { id: 'u1', username: 'ann_1' },
      bonus: null,
      referral: null,
    });
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'u1', claimedAt: null },
      data: { username: 'ann_1', claimedAt: expect.any(Date) },
    });
  });

  it('refuses a second claim', async () => {
    await expect(codeOf(build(new Date()).svc.claim(user(), { username: 'ann_1' }))).resolves.toBe('ALREADY_CLAIMED');
  });

  it('refuses a suspended account', async () => {
    await expect(codeOf(build().svc.claim(user('suspended'), { username: 'ann_1' }))).resolves.toBe('ACCOUNT_SUSPENDED');
  });
});
