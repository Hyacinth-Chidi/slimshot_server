import { Prisma } from '../../generated/prisma/client';
import { EnvelopeCryptoService } from '../crypto/envelope-crypto.service';
import { SettingsService } from './settings.service';

const KEY = 'b'.repeat(64);

function prismaMock() {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    systemSetting: {
      findUnique: jest.fn(async ({ where }: { where: { key: string } }) =>
        rows.get(where.key) ?? null,
      ),
      upsert: jest.fn(
        async ({
          where,
          create,
        }: {
          where: { key: string };
          create: Record<string, unknown>;
        }) => {
          rows.set(where.key, create);
          return create;
        },
      ),
    },
  };
}

describe('SettingsService', () => {
  const crypto = new EnvelopeCryptoService(KEY);

  it('returns the registry default when no row exists', async () => {
    const svc = new SettingsService(prismaMock() as never, crypto);
    await expect(svc.get('upload.audio.maxBytes')).resolves.toBe(52_428_800);
  });

  it('returns a stored non-secret value over the default', async () => {
    const svc = new SettingsService(prismaMock() as never, crypto);
    await svc.set('upload.audio.maxBytes', 1234, 'admin-1');
    await expect(svc.get('upload.audio.maxBytes')).resolves.toBe(1234);
  });

  it('encrypts a secret on write and decrypts it on read', async () => {
    const prisma = prismaMock();
    const svc = new SettingsService(prisma as never, crypto);
    await svc.set('auth.jwtAccessSecret', 'super-secret', 'admin-1');

    const row = prisma.rows.get('auth.jwtAccessSecret')!;
    // Prisma's typed client requires the Prisma.DbNull sentinel (not plain
    // `null`) to set a nullable Json column to a real SQL NULL — see
    // settings.service.ts's `sealed()`. It serializes to NULL at the database;
    // this in-memory mock just stores whatever object was passed as `create`.
    expect(row.valueJson).toBe(Prisma.DbNull);
    expect((row.valueCipher as Buffer).toString('utf8')).not.toContain('super-secret');

    await expect(svc.get('auth.jwtAccessSecret')).resolves.toBe('super-secret');
  });

  it('rejects a value that fails the registry validator and writes nothing', async () => {
    const prisma = prismaMock();
    const svc = new SettingsService(prisma as never, crypto);
    await expect(svc.set('upload.audio.maxBytes', -1, 'admin-1')).rejects.toThrow(
      /at least 1/,
    );
    expect(prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });

  it('rejects an unknown setting key', async () => {
    const svc = new SettingsService(prismaMock() as never, crypto);
    await expect(svc.set('nope.not.real', 1, 'admin-1')).rejects.toThrow(
      /unknown setting/i,
    );
  });

  it('masks secrets when listing a group', async () => {
    const svc = new SettingsService(prismaMock() as never, crypto);
    await svc.set('auth.jwtAccessSecret', 'sk_live_abcdef123456', 'admin-1');

    const listed = await svc.getMaskedGroup('auth');
    const secret = listed.find((s) => s.key === 'auth.jwtAccessSecret')!;
    // EnvelopeCryptoService.mask reveals at most a third of the value, split
    // between prefix and suffix (fixed for a security bug that used to leak
    // more). For 'sk_live_abcdef123456' (20 chars) that is 'sk_' + bullets + '456'.
    expect(secret.value).toBe('sk_••••456');
    expect(secret.isSecret).toBe(true);
  });

  it('never returns a raw secret from getMaskedGroup', async () => {
    const svc = new SettingsService(prismaMock() as never, crypto);
    await svc.set('auth.jwtAccessSecret', 'sk_live_abcdef123456', 'admin-1');
    const listed = await svc.getMaskedGroup('auth');
    expect(JSON.stringify(listed)).not.toContain('abcdef12');
  });

  it('caches a read and does not hit the database twice', async () => {
    const prisma = prismaMock();
    const svc = new SettingsService(prisma as never, crypto);
    await svc.get('upload.ticketTtlSeconds');
    await svc.get('upload.ticketTtlSeconds');
    expect(prisma.systemSetting.findUnique).toHaveBeenCalledTimes(1);
  });

  it('invalidates the cache on write', async () => {
    const svc = new SettingsService(prismaMock() as never, crypto);
    await svc.get('upload.ticketTtlSeconds');
    await svc.set('upload.ticketTtlSeconds', 300, 'admin-1');
    await expect(svc.get('upload.ticketTtlSeconds')).resolves.toBe(300);
  });
});
