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
    // auth.jwtAccessSecret now declares minLength: 32 (Finding 1, fix round 1) —
    // this value must satisfy it or `set` will reject it before writing anything.
    const strong = 'super-secret-value-that-is-long-enough';
    await svc.set('auth.jwtAccessSecret', strong, 'admin-1');

    const row = prisma.rows.get('auth.jwtAccessSecret')!;
    // Prisma's typed client requires the Prisma.DbNull sentinel (not plain
    // `null`) to set a nullable Json column to a real SQL NULL — see
    // settings.service.ts's `sealed()`. It serializes to NULL at the database;
    // this in-memory mock just stores whatever object was passed as `create`.
    expect(row.valueJson).toBe(Prisma.DbNull);
    expect((row.valueCipher as Buffer).toString('utf8')).not.toContain(strong);

    await expect(svc.get('auth.jwtAccessSecret')).resolves.toBe(strong);
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
    // 35 chars, comfortably over auth.jwtAccessSecret's minLength: 32. The
    // prefix is deliberately NOT shaped like any real provider's key format:
    // secret scanners match on the prefix alone and will block a push over a
    // fixture that was never a credential.
    const strong = 'tok_sample_abcdef123456789012345678';
    await svc.set('auth.jwtAccessSecret', strong, 'admin-1');

    const listed = await svc.getMaskedGroup('auth');
    const secret = listed.find((s) => s.key === 'auth.jwtAccessSecret')!;
    // mask reveals at most a third, split prefix/suffix (fixed for a security
    // bug that used to leak more). 35 chars -> 'tok_sam' + bullets + '5678'.
    expect(secret.value).toBe('tok_sam••••5678');
    expect(secret.isSecret).toBe(true);
  });

  it('never returns a raw secret from getMaskedGroup', async () => {
    const svc = new SettingsService(prismaMock() as never, crypto);
    await svc.set(
      'auth.jwtAccessSecret',
      'tok_sample_abcdef123456789012345678',
      'admin-1',
    );
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

  it('refuses to return an unset secret that has a minLength', async () => {
    const svc = new SettingsService(prismaMock() as never, crypto);
    await expect(svc.get('auth.jwtAccessSecret')).rejects.toThrow(
      /unset or too short/,
    );
  });

  it('returns the secret once it is long enough', async () => {
    const svc = new SettingsService(prismaMock() as never, crypto);
    const strong = 'k'.repeat(48);
    await svc.set('auth.jwtAccessSecret', strong, 'admin-1');
    await expect(svc.get('auth.jwtAccessSecret')).resolves.toBe(strong);
  });

  it('throws when a stored value does not match its declared type', async () => {
    const prisma = prismaMock();
    const svc = new SettingsService(prisma as never, crypto);
    prisma.rows.set('upload.audio.maxBytes', {
      key: 'upload.audio.maxBytes',
      group: 'upload',
      isSecret: false,
      valueJson: 'not-a-number',
      valueCipher: null,
      keyVersion: null,
    });
    await expect(svc.get('upload.audio.maxBytes')).rejects.toThrow(
      /stored value is string but the definition declares int/,
    );
  });

  it('reveals the true value of a secret setting', async () => {
    const svc = new SettingsService(prismaMock() as never, crypto);
    const real = 'tok_sample_abcdef123456789012345678';
    await svc.set('auth.jwtAccessSecret', real, 'admin-1');

    await expect(svc.revealSecret('auth.jwtAccessSecret')).resolves.toBe(real);
  });

  it('refuses to reveal a setting that is not marked secret', async () => {
    const svc = new SettingsService(prismaMock() as never, crypto);
    // Reveal exists for credentials. A non-secret setting is already readable
    // via get(), so routing it through the privileged path would be a way to
    // normalise calling reveal on anything.
    await expect(svc.revealSecret('upload.audio.maxBytes')).rejects.toThrow(
      /not a secret/i,
    );
  });
});
