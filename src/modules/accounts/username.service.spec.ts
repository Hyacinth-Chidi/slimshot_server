import { HttpException } from '@nestjs/common';

import { UsernameService } from './username.service';

function build(owners: Record<string, string> = { taken_1: 'u2' }) {
  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where }: { where: { username: string } }) =>
        owners[where.username] ? { id: owners[where.username] } : null,
      ),
      update: jest.fn(async () => undefined),
    },
  };
  return { prisma, svc: new UsernameService(prisma as never) };
}

describe('UsernameService', () => {
  it.each([
    ['  Ann_1 ', { username: 'ann_1', available: true }],
    ['ab', { username: 'ab', available: false, reason: 'INVALID' }],
    ['admin', { username: 'admin', available: false, reason: 'RESERVED' }],
    ['Taken_1', { username: 'taken_1', available: false, reason: 'TAKEN' }],
  ])('checks %j', async (raw, expected) => {
    await expect(build().svc.check(raw, 'u1')).resolves.toEqual(expected);
  });

  it('treats your own current username as available', async () => {
    await expect(build({ ann_1: 'u1' }).svc.check('ann_1', 'u1')).resolves.toMatchObject({ available: true });
  });

  it('changes the username, and maps a race on the unique index to USERNAME_TAKEN', async () => {
    const { svc, prisma } = build();
    await expect(svc.change('u1', 'Ann_2')).resolves.toBe('ann_2');
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { username: 'ann_2' } });

    prisma.user.update.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }));
    const error = (await svc.change('u1', 'ann_3').catch((e: unknown) => e)) as HttpException;
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toMatchObject({ code: 'USERNAME_TAKEN' });
  });
});
