import { AuditService } from './audit.service';

function prismaMock() {
  return { auditLog: { create: jest.fn(async ({ data }: { data: unknown }) => data) } };
}

describe('AuditService', () => {
  it('writes the entry', async () => {
    const prisma = prismaMock();
    const svc = new AuditService(prisma as never);

    await svc.record({
      actorId: 'admin-1',
      actorType: 'admin',
      action: 'asset.publish',
      entityType: 'Asset',
      entityId: 'a1',
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'asset.publish', entityId: 'a1' }),
    });
  });

  it('redacts secret-looking fields from the before/after payload', async () => {
    const prisma = prismaMock();
    const svc = new AuditService(prisma as never);

    await svc.record({
      actorType: 'admin',
      action: 'settings.update',
      entityType: 'SystemSetting',
      after: { key: 'auth.jwtAccessSecret', apiSecret: 'hunter2', password: 'p' },
    });

    const written = prisma.auditLog.create.mock.calls[0][0].data as {
      after: Record<string, unknown>;
    };
    expect(written.after.apiSecret).toBe('[redacted]');
    expect(written.after.password).toBe('[redacted]');
    expect(JSON.stringify(written)).not.toContain('hunter2');
  });

  it('never throws, so a failed audit write cannot fail the request', async () => {
    const prisma = prismaMock();
    prisma.auditLog.create.mockRejectedValue(new Error('db down'));
    const svc = new AuditService(prisma as never);

    await expect(
      svc.record({ actorType: 'system', action: 'x', entityType: 'y' }),
    ).resolves.toBeUndefined();
  });
});
