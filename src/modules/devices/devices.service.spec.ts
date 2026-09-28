import { createHash } from 'node:crypto';

import { DevicesService } from './devices.service';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function build(lastSeenAt = new Date()) {
  const devices: Array<{ id: string; tokenHash: string; lastSeenAt: Date }> = [];
  const prisma = {
    device: {
      create: jest.fn(async ({ data }: { data: { tokenHash: string } }) => {
        const row = { id: `dev-${devices.length + 1}`, lastSeenAt, ...data };
        devices.push(row);
        return { id: row.id };
      }),
      findUnique: jest.fn(async ({ where }: { where: { tokenHash: string } }) =>
        devices.find((d) => d.tokenHash === where.tokenHash) ?? null,
      ),
      update: jest.fn(async () => undefined),
    },
  };
  return { svc: new DevicesService(prisma as never), prisma, devices };
}

describe('DevicesService.register', () => {
  it('returns the token once and stores only its SHA-256', async () => {
    const { svc, prisma } = build();
    const { deviceId, token } = await svc.register({ platform: 'android', appVersion: '1.4.0' });

    expect(deviceId).toBe('dev-1');
    expect(token.length).toBeGreaterThanOrEqual(43);
    const data = prisma.device.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).toEqual({ tokenHash: sha256(token), platform: 'android', appVersion: '1.4.0' });
    expect(JSON.stringify(data)).not.toContain(token);
  });

  it('issues a different token every time', async () => {
    const { svc } = build();
    const a = await svc.register({});
    const b = await svc.register({});
    expect(a.token).not.toBe(b.token);
  });
});

describe('DevicesService.authenticate', () => {
  it('finds the device by the hash of its token', async () => {
    const { svc } = build();
    const { token } = await svc.register({});
    await expect(svc.authenticate(token)).resolves.toEqual({ id: 'dev-1' });
  });

  it('returns null for an unknown or empty token', async () => {
    const { svc, prisma } = build();
    await expect(svc.authenticate('nope')).resolves.toBeNull();
    await expect(svc.authenticate('')).resolves.toBeNull();
    expect(prisma.device.findUnique).toHaveBeenCalledTimes(1);
  });

  it('records lastSeenAt at most once a minute', async () => {
    const fresh = build(new Date());
    const t1 = (await fresh.svc.register({})).token;
    await fresh.svc.authenticate(t1);
    expect(fresh.prisma.device.update).not.toHaveBeenCalled();

    const stale = build(new Date(Date.now() - 61_000));
    const t2 = (await stale.svc.register({})).token;
    await stale.svc.authenticate(t2);
    expect(stale.prisma.device.update).toHaveBeenCalledWith({
      where: { id: 'dev-1' },
      data: { lastSeenAt: expect.any(Date) },
    });
  });
});
