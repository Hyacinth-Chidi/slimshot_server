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

  it('never writes raw bytes for a Buffer, whatever the field is called', async () => {
    const prisma = prismaMock();
    const svc = new AuditService(prisma as never);

    await svc.record({
      actorType: 'admin',
      action: 'settings.update',
      entityType: 'SystemSetting',
      after: { valueCipher: Buffer.from('SUPERSECRETBYTES', 'utf8') },
    });

    const written = JSON.stringify(prisma.auditLog.create.mock.calls[0][0]);
    expect(written).not.toContain('"0":83');
    expect(written).not.toContain('SUPERSECRETBYTES');
    expect(written).toContain('[binary 16 bytes]');
  });

  it('serializes a Date instead of losing it', async () => {
    const prisma = prismaMock();
    const svc = new AuditService(prisma as never);

    await svc.record({
      actorType: 'admin',
      action: 'asset.publish',
      entityType: 'Asset',
      after: { publishedAt: new Date('2026-01-01T00:00:00.000Z') },
    });

    const written = prisma.auditLog.create.mock.calls[0][0].data as {
      after: Record<string, unknown>;
    };
    expect(written.after.publishedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('redacts the widened set of secret-ish field names', async () => {
    const prisma = prismaMock();
    const svc = new AuditService(prisma as never);

    await svc.record({
      actorType: 'admin',
      action: 'settings.update',
      entityType: 'SystemSetting',
      after: {
        privateKey: 'LEAK-A',
        signature: 'LEAK-B',
        authorization: 'LEAK-C',
        passphrase: 'LEAK-D',
        authorName: 'keep-me',
      },
    });

    const written = JSON.stringify(prisma.auditLog.create.mock.calls[0][0]);
    for (const leak of ['LEAK-A', 'LEAK-B', 'LEAK-C', 'LEAK-D']) {
      expect(written).not.toContain(leak);
    }
    expect(written).toContain('keep-me');
  });
});
