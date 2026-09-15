import { ServiceUnavailableException } from '@nestjs/common';

import { HealthController } from './health.controller';

function deps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    prisma: { $queryRaw: jest.fn(async () => [{ ok: 1 }]) },
    redis: { ping: jest.fn(async () => 'PONG') },
    storage: { getDefault: jest.fn(async () => ({ id: 'prov-1' })) },
    ...overrides,
  };
}

describe('HealthController', () => {
  it('liveness returns ok without touching any dependency', () => {
    const d = deps();
    const c = new HealthController(d.prisma as never, d.redis as never, d.storage as never);
    expect(c.live()).toEqual({ status: 'ok' });
    expect(d.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('readiness reports every dependency up', async () => {
    const d = deps();
    const c = new HealthController(d.prisma as never, d.redis as never, d.storage as never);
    await expect(c.ready()).resolves.toEqual({
      status: 'ok',
      checks: { database: 'up', redis: 'up', storage: 'up' },
    });
  });

  it('readiness throws 503 when the database is down', async () => {
    const d = deps({ prisma: { $queryRaw: jest.fn().mockRejectedValue(new Error('x')) } });
    const c = new HealthController(d.prisma as never, d.redis as never, d.storage as never);
    await expect(c.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('readiness names which dependency failed', async () => {
    const d = deps({ redis: { ping: jest.fn().mockRejectedValue(new Error('x')) } });
    const c = new HealthController(d.prisma as never, d.redis as never, d.storage as never);
    await expect(c.ready()).rejects.toMatchObject({
      response: { checks: { redis: 'down', database: 'up' } },
    });
  });
});
