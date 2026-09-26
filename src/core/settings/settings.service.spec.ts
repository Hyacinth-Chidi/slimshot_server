import { Prisma } from '../../generated/prisma/client';
import { EnvelopeCryptoService } from '../crypto/envelope-crypto.service';
import { SettingsService } from './settings.service';

// The real registry has no secret with a minLength today (the JWT secret moved
// to the environment). The service still supports one, so these tests add a
// test-only definition rather than lose coverage of that behaviour.
jest.mock('./setting-definitions', () => {
  const actual = jest.requireActual('./setting-definitions');
  const { defineSetting } = jest.requireActual('./setting-registry');
  const fixture = defineSetting({
    key: 'test.signingSecret',
    group: 'auth',
    type: 'string',
    default: '',
    secret: true,
    minLength: 32,
  });
  return {
    SETTING_DEFINITIONS: [...actual.SETTING_DEFINITIONS, fixture],
    SETTINGS: new Map([...actual.SETTINGS, [fixture.key, fixture]]),
  };
});

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

  it('falls back to an env var when no row exists and the definition names one', async () => {
    // Local development needs a Redis that is not localhost before any admin
    // has logged in to set it. The DB row stays authoritative; this only fills
    // the gap where there is no row at all.
    process.env.REDIS_URL = 'redis://env-host:6379';
    const svc = new SettingsService(prismaMock() as never, crypto);
    await expect(svc.get('redis.url')).resolves.toBe('redis://env-host:6379');
    delete process.env.REDIS_URL;
  });

  it('prefers a stored row over the env fallback', async () => {
    // The whole point of storing settings in the DB is that an admin can
    // change them at runtime. An env var that outranked the row would make the
    // settings screen silently ineffective.
    process.env.REDIS_URL = 'redis://env-host:6379';
    const svc = new SettingsService(prismaMock() as never, crypto);
    await svc.set('redis.url', 'redis://db-host:6379', 'admin-1');
    await expect(svc.get('redis.url')).resolves.toBe('redis://db-host:6379');
    delete process.env.REDIS_URL;
  });

  it('uses the registry default when the env var is absent', async () => {
    delete process.env.REDIS_URL;
    const svc = new SettingsService(prismaMock() as never, crypto);
    await expect(svc.get('redis.url')).resolves.toBe('redis://localhost:6379');
  });

  it('ignores an empty env var rather than treating it as configured', async () => {
    // An unset var in a .env file often arrives as '' rather than undefined.
    // Treating that as a value yields an empty connection URL.
    process.env.REDIS_URL = '';
    const svc = new SettingsService(prismaMock() as never, crypto);
    await expect(svc.get('redis.url')).resolves.toBe('redis://localhost:6379');
    delete process.env.REDIS_URL;
  });

  it('returns a stored non-secret value over the default', async () => {
    const svc = new SettingsService(prismaMock() as never, crypto);
    await svc.set('upload.audio.maxBytes', 1234, 'admin-1');
    await expect(svc.get('upload.audio.maxBytes')).resolves.toBe(1234);
  });

  it('encrypts a secret on write and decrypts it on read', async () => {
    const prisma = prismaMock();
    const svc = new SettingsService(prisma as never, crypto);
    // test.signingSecret declares minLength: 32 — this value must satisfy it
    // or `set` will reject it before writing anything.
    const strong = 'super-secret-value-that-is-long-enough';
    await svc.set('test.signingSecret', strong, 'admin-1');

    const row = prisma.rows.get('test.signingSecret')!;
    // Prisma's typed client requires the Prisma.DbNull sentinel (not plain
    // `null`) to set a nullable Json column to a real SQL NULL — see
    // settings.service.ts's `sealed()`. It serializes to NULL at the database;
    // this in-memory mock just stores whatever object was passed as `create`.
    expect(row.valueJson).toBe(Prisma.DbNull);
    expect((row.valueCipher as Buffer).toString('utf8')).not.toContain(strong);

    await expect(svc.get('test.signingSecret')).resolves.toBe(strong);
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
    // 35 chars, comfortably over test.signingSecret's minLength: 32. The
    // prefix is deliberately NOT shaped like any real provider's key format:
    // secret scanners match on the prefix alone and will block a push over a
    // fixture that was never a credential.
    const strong = 'tok_sample_abcdef123456789012345678';
    await svc.set('test.signingSecret', strong, 'admin-1');

    const listed = await svc.getMaskedGroup('auth');
    const secret = listed.find((s) => s.key === 'test.signingSecret')!;
    // mask reveals at most a third, split prefix/suffix (fixed for a security
    // bug that used to leak more). 35 chars -> 'tok_sam' + bullets + '5678'.
    expect(secret.value).toBe('tok_sam••••5678');
    expect(secret.isSecret).toBe(true);
  });

  it('marks an unconfigured minLength secret as configured: false instead of throwing', async () => {
    const svc = new SettingsService(prismaMock() as never, crypto);
    // test.signingSecret defaults to '' and has minLength: 32, so get() would
    // throw for it alone. Until someone sets it, the whole group must still
    // render so an operator can see the page and set the value.
    const listed = await svc.getMaskedGroup('auth');

    const unset = listed.find((s) => s.key === 'test.signingSecret')!;
    expect(unset.configured).toBe(false);
    expect(unset.value).toBeNull();

    // Sibling non-secret settings in the same group must still come back
    // normally — the fix must not swallow errors group-wide.
    const sibling = listed.find((s) => s.key === 'auth.loginMaxAttempts')!;
    expect(sibling.configured).toBe(true);
    expect(sibling.value).toBe(5);
  });

  it('marks a configured secret as configured: true and still masks its value', async () => {
    const svc = new SettingsService(prismaMock() as never, crypto);
    const strong = 'tok_sample_abcdef123456789012345678';
    await svc.set('test.signingSecret', strong, 'admin-1');

    const listed = await svc.getMaskedGroup('auth');
    const secret = listed.find((s) => s.key === 'test.signingSecret')!;
    expect(secret.configured).toBe(true);
    expect(secret.value).toBe('tok_sam••••5678');
  });

  it('still propagates an unrelated error from get() rather than tolerating it', async () => {
    const prisma = prismaMock();
    const svc = new SettingsService(prisma as never, crypto);
    // A stored value that mismatches the declared type is a different failure
    // mode than "not configured yet" and must not be swallowed.
    prisma.rows.set('upload.audio.maxBytes', {
      key: 'upload.audio.maxBytes',
      group: 'upload',
      isSecret: false,
      valueJson: 'not-a-number',
      valueCipher: null,
      keyVersion: null,
    });

    await expect(svc.getMaskedGroup('upload')).rejects.toThrow(
      /stored value is string but the definition declares int/,
    );
  });

  it('never returns a raw secret from getMaskedGroup', async () => {
    const svc = new SettingsService(prismaMock() as never, crypto);
    await svc.set(
      'test.signingSecret',
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
    await expect(svc.get('test.signingSecret')).rejects.toThrow(
      /unset or too short/,
    );
  });

  it('returns the secret once it is long enough', async () => {
    const svc = new SettingsService(prismaMock() as never, crypto);
    const strong = 'k'.repeat(48);
    await svc.set('test.signingSecret', strong, 'admin-1');
    await expect(svc.get('test.signingSecret')).resolves.toBe(strong);
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
    await svc.set('test.signingSecret', real, 'admin-1');

    await expect(svc.revealSecret('test.signingSecret')).resolves.toBe(real);
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
