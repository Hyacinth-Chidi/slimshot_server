import { ElevationService } from './elevation.service';

function fakeRedis() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  return {
    store,
    ttls,
    set: jest.fn(async (k: string, v: string, mode?: string, seconds?: number) => {
      store.set(k, v);
      // Record the expiry so a test can assert it. A fake that silently drops
      // the TTL lets a grant-never-expires bug pass every test.
      if (mode === 'EX' && typeof seconds === 'number') ttls.set(k, seconds);
      return 'OK';
    }),
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    del: jest.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
    keys: jest.fn(async (pattern: string) => {
      const prefix = pattern.replace(/\*$/, '');
      return [...store.keys()].filter((k) => k.startsWith(prefix));
    }),
  };
}

describe('ElevationService', () => {
  it('issues a grant that validates for the same admin and key', async () => {
    const svc = new ElevationService(fakeRedis() as never);
    const grant = await svc.issue('admin-1', 'auth.jwtAccessSecret');

    await expect(
      svc.consume(grant, 'admin-1', 'auth.jwtAccessSecret'),
    ).resolves.toBe(true);
  });

  it('refuses a grant for a DIFFERENT setting key', async () => {
    const svc = new ElevationService(fakeRedis() as never);
    const grant = await svc.issue('admin-1', 'auth.jwtAccessSecret');

    // Scoping is what stops one unlock authorising every credential.
    await expect(svc.consume(grant, 'admin-1', 'redis.url')).resolves.toBe(false);
  });

  it('refuses a grant issued to a DIFFERENT admin', async () => {
    const svc = new ElevationService(fakeRedis() as never);
    const grant = await svc.issue('admin-1', 'auth.jwtAccessSecret');

    await expect(
      svc.consume(grant, 'admin-2', 'auth.jwtAccessSecret'),
    ).resolves.toBe(false);
  });

  it('refuses a grant that has already been consumed', async () => {
    const svc = new ElevationService(fakeRedis() as never);
    const grant = await svc.issue('admin-1', 'auth.jwtAccessSecret');

    await svc.consume(grant, 'admin-1', 'auth.jwtAccessSecret');
    // Single-use is the property that makes a grant safer than a lingering
    // password. A replayable grant is a durable credential.
    await expect(
      svc.consume(grant, 'admin-1', 'auth.jwtAccessSecret'),
    ).resolves.toBe(false);
  });

  it('refuses an unknown grant', async () => {
    const svc = new ElevationService(fakeRedis() as never);
    await expect(
      svc.consume('never-issued', 'admin-1', 'auth.jwtAccessSecret'),
    ).resolves.toBe(false);
  });

  it('revokes every grant belonging to an admin', async () => {
    const svc = new ElevationService(fakeRedis() as never);
    const g1 = await svc.issue('admin-1', 'auth.jwtAccessSecret');
    const g2 = await svc.issue('admin-1', 'redis.url');

    await svc.revokeForAdmin('admin-1');

    await expect(svc.consume(g1, 'admin-1', 'auth.jwtAccessSecret')).resolves.toBe(false);
    await expect(svc.consume(g2, 'admin-1', 'redis.url')).resolves.toBe(false);
  });

  it('stores only a hash of the grant, never the grant itself', async () => {
    const redis = fakeRedis();
    const svc = new ElevationService(redis as never);
    const grant = await svc.issue('admin-1', 'auth.jwtAccessSecret');

    expect([...redis.store.keys()].some((k) => k.includes(grant))).toBe(false);
  });

  it('issues the grant with a 120 second expiry', async () => {
    const redis = fakeRedis();
    const svc = new ElevationService(redis as never);
    await svc.issue('admin-1', 'auth.jwtAccessSecret');

    // Without an expiry a grant is a permanent credential. This asserts the TTL
    // reaches Redis, which the previous fake silently discarded.
    const [ttl] = [...redis.ttls.values()];
    expect(ttl).toBe(120);
  });

  it('refuses a grant whose Redis entry has expired', async () => {
    const redis = fakeRedis();
    const svc = new ElevationService(redis as never);
    const grant = await svc.issue('admin-1', 'auth.jwtAccessSecret');

    // Simulate Redis evicting the key at TTL. consume must fail closed.
    redis.store.clear();

    await expect(
      svc.consume(grant, 'admin-1', 'auth.jwtAccessSecret'),
    ).resolves.toBe(false);
  });

  it('denies a grant whose stored value is corrupt rather than throwing', async () => {
    const redis = fakeRedis();
    const svc = new ElevationService(redis as never);
    const grant = await svc.issue('admin-1', 'auth.jwtAccessSecret');

    // Overwrite with junk, as a foreign writer or a partial write would.
    const [key] = [...redis.store.keys()];
    redis.store.set(key, 'not-json{{{');

    await expect(
      svc.consume(grant, 'admin-1', 'auth.jwtAccessSecret'),
    ).resolves.toBe(false);
  });
});
