import { createHash } from 'node:crypto';

import { ElevationService } from './elevation.service';

/** Derived here independently, so a test never trusts the service's own layout. */
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

function fakeRedis() {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const ttls = new Map<string, number>();

  // Expiring a key must drop it from whichever shape holds it, so a test that
  // simulates eviction cannot leave a ghost behind in the other map.
  const drop = (k: string) => {
    const existed = store.delete(k);
    const setExisted = sets.delete(k);
    ttls.delete(k);
    return existed || setExisted ? 1 : 0;
  };

  return {
    store,
    sets,
    ttls,
    set: jest.fn(async (k: string, v: string, mode?: string, seconds?: number) => {
      store.set(k, v);
      // Record the expiry so a test can assert it. A fake that silently drops
      // the TTL lets a grant-never-expires bug pass every test.
      if (mode === 'EX' && typeof seconds === 'number') ttls.set(k, seconds);
      return 'OK';
    }),
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    // Real DEL is variadic and returns the count actually removed. Modelling
    // that is what lets a test prove a stale member is a no-op, not an error.
    del: jest.fn(async (...ks: string[]) => ks.reduce((n, k) => n + drop(k), 0)),
    keys: jest.fn(async (pattern: string) => {
      const prefix = pattern.replace(/\*$/, '');
      return [...store.keys(), ...sets.keys()].filter((k) => k.startsWith(prefix));
    }),
    sadd: jest.fn(async (k: string, ...members: string[]) => {
      const set = sets.get(k) ?? new Set<string>();
      sets.set(k, set);
      let added = 0;
      for (const m of members) if (!set.has(m)) { set.add(m); added += 1; }
      return added;
    }),
    smembers: jest.fn(async (k: string) => [...(sets.get(k) ?? [])]),
    srem: jest.fn(async (k: string, ...members: string[]) => {
      const set = sets.get(k);
      if (!set) return 0;
      let removed = 0;
      for (const m of members) if (set.delete(m)) removed += 1;
      // Redis deletes a set that becomes empty; modelling that keeps
      // "set missing entirely" a reachable state in tests.
      if (set.size === 0) { sets.delete(k); ttls.delete(k); }
      return removed;
    }),
    // EXPIRE is a no-op on a missing key in Redis, and returns 0. Honouring
    // that stops a bug that expires the wrong key from passing.
    expire: jest.fn(async (k: string, seconds: number) => {
      if (!store.has(k) && !sets.has(k)) return 0;
      ttls.set(k, seconds);
      return 1;
    }),
  };
}

/**
 * A pipeline that queues calls and replays them onto the SAME fake methods on
 * exec(). It deliberately does not reimplement any command: a pipelined SET
 * that dropped its 'EX' would have to drop it in the one shared implementation,
 * where the TTL assertions would catch it. A pipeline fake with its own
 * shortcut copies of the commands is exactly how an argument gets silently
 * discarded.
 */
function withPipeline(redis: ReturnType<typeof fakeRedis>) {
  type Call = [keyof typeof redis, unknown[]];
  return Object.assign(redis, {
    pipeline: jest.fn(() => {
      const queued: Call[] = [];
      const chain = {
        set: (...args: unknown[]) => (queued.push(['set', args]), chain),
        del: (...args: unknown[]) => (queued.push(['del', args]), chain),
        sadd: (...args: unknown[]) => (queued.push(['sadd', args]), chain),
        srem: (...args: unknown[]) => (queued.push(['srem', args]), chain),
        expire: (...args: unknown[]) => (queued.push(['expire', args]), chain),
        exec: async () => {
          const results: [null, unknown][] = [];
          for (const [name, args] of queued) {
            const fn = redis[name] as (...a: unknown[]) => Promise<unknown>;
            results.push([null, await fn(...args)]);
          }
          return results;
        },
      };
      return chain;
    }),
  });
}

describe('ElevationService', () => {
  it('issues a grant that validates for the same admin and key', async () => {
    const svc = new ElevationService(withPipeline(fakeRedis()) as never);
    const grant = await svc.issue('admin-1', 'auth.jwtAccessSecret');

    await expect(
      svc.consume(grant, 'admin-1', 'auth.jwtAccessSecret'),
    ).resolves.toBe(true);
  });

  it('refuses a grant for a DIFFERENT setting key', async () => {
    const svc = new ElevationService(withPipeline(fakeRedis()) as never);
    const grant = await svc.issue('admin-1', 'auth.jwtAccessSecret');

    // Scoping is what stops one unlock authorising every credential.
    await expect(svc.consume(grant, 'admin-1', 'redis.url')).resolves.toBe(false);
  });

  it('refuses a grant issued to a DIFFERENT admin', async () => {
    const svc = new ElevationService(withPipeline(fakeRedis()) as never);
    const grant = await svc.issue('admin-1', 'auth.jwtAccessSecret');

    await expect(
      svc.consume(grant, 'admin-2', 'auth.jwtAccessSecret'),
    ).resolves.toBe(false);
  });

  it('refuses a grant that has already been consumed', async () => {
    const svc = new ElevationService(withPipeline(fakeRedis()) as never);
    const grant = await svc.issue('admin-1', 'auth.jwtAccessSecret');

    await svc.consume(grant, 'admin-1', 'auth.jwtAccessSecret');
    // Single-use is the property that makes a grant safer than a lingering
    // password. A replayable grant is a durable credential.
    await expect(
      svc.consume(grant, 'admin-1', 'auth.jwtAccessSecret'),
    ).resolves.toBe(false);
  });

  it('refuses an unknown grant', async () => {
    const svc = new ElevationService(withPipeline(fakeRedis()) as never);
    await expect(
      svc.consume('never-issued', 'admin-1', 'auth.jwtAccessSecret'),
    ).resolves.toBe(false);
  });

  it('revokes every grant belonging to an admin', async () => {
    const svc = new ElevationService(withPipeline(fakeRedis()) as never);
    const g1 = await svc.issue('admin-1', 'auth.jwtAccessSecret');
    const g2 = await svc.issue('admin-1', 'redis.url');

    await svc.revokeForAdmin('admin-1');

    await expect(svc.consume(g1, 'admin-1', 'auth.jwtAccessSecret')).resolves.toBe(false);
    await expect(svc.consume(g2, 'admin-1', 'redis.url')).resolves.toBe(false);
  });

  it('stores only a hash of the grant, never the grant itself', async () => {
    const redis = withPipeline(fakeRedis());
    const svc = new ElevationService(redis as never);
    const grant = await svc.issue('admin-1', 'auth.jwtAccessSecret');

    expect([...redis.store.keys()].some((k) => k.includes(grant))).toBe(false);
  });

  it('issues the grant with a 120 second expiry', async () => {
    const redis = withPipeline(fakeRedis());
    const svc = new ElevationService(redis as never);
    await svc.issue('admin-1', 'auth.jwtAccessSecret');

    // Without an expiry a grant is a permanent credential. This asserts the TTL
    // reaches Redis, which the previous fake silently discarded.
    const [ttl] = [...redis.ttls.values()];
    expect(ttl).toBe(120);
  });

  it('refuses a grant whose Redis entry has expired', async () => {
    const redis = withPipeline(fakeRedis());
    const svc = new ElevationService(redis as never);
    const grant = await svc.issue('admin-1', 'auth.jwtAccessSecret');

    // Simulate Redis evicting the key at TTL. consume must fail closed.
    redis.store.clear();

    await expect(
      svc.consume(grant, 'admin-1', 'auth.jwtAccessSecret'),
    ).resolves.toBe(false);
  });

  it('denies a grant whose stored value is corrupt rather than throwing', async () => {
    const redis = withPipeline(fakeRedis());
    const svc = new ElevationService(redis as never);
    const grant = await svc.issue('admin-1', 'auth.jwtAccessSecret');

    // Overwrite with junk, as a foreign writer or a partial write would.
    const [key] = [...redis.store.keys()];
    redis.store.set(key, 'not-json{{{');

    await expect(
      svc.consume(grant, 'admin-1', 'auth.jwtAccessSecret'),
    ).resolves.toBe(false);
  });
  it('revokes admin A without touching admin B', async () => {
    const svc = new ElevationService(withPipeline(fakeRedis()) as never);
    const a = await svc.issue('admin-1', 'auth.jwtAccessSecret');
    const b = await svc.issue('admin-2', 'auth.jwtAccessSecret');

    await svc.revokeForAdmin('admin-1');

    await expect(svc.consume(a, 'admin-1', 'auth.jwtAccessSecret')).resolves.toBe(false);
    // The per-admin index is the whole safety story here: a revocation that
    // reached across admins would log everyone out of their elevation.
    await expect(svc.consume(b, 'admin-2', 'auth.jwtAccessSecret')).resolves.toBe(true);
  });

  it('revokes WITHOUT a KEYS scan', async () => {
    const redis = withPipeline(fakeRedis());
    const svc = new ElevationService(redis as never);
    await svc.issue('admin-1', 'auth.jwtAccessSecret');

    await svc.revokeForAdmin('admin-1');

    // KEYS blocks Redis for the whole keyspace, and this runs on every logout
    // against a keyspace that grows without bound (retained failed BullMQ
    // jobs). The per-admin index exists precisely to avoid it.
    expect(redis.keys).not.toHaveBeenCalled();
  });

  it('revokes cleanly when the admin has no index set at all', async () => {
    const redis = withPipeline(fakeRedis());
    const svc = new ElevationService(redis as never);

    // Never issued, or the set expired/was evicted. Must not throw, and must
    // not delete anything it does not own.
    await expect(svc.revokeForAdmin('admin-nobody')).resolves.toBeUndefined();
    expect(redis.keys).not.toHaveBeenCalled();
  });

  it('revokes without error when a member grant key has already expired', async () => {
    const redis = withPipeline(fakeRedis());
    const svc = new ElevationService(redis as never);
    const live = await svc.issue('admin-1', 'auth.jwtAccessSecret');
    await svc.issue('admin-1', 'redis.url');

    // Expire the SECOND grant's key as Redis would at TTL, while leaving its
    // id in the index set. This is the normal steady state, not an edge case:
    // grant keys and their index entries expire independently.
    const setKey = [...redis.sets.keys()][0];
    const staleMember = [...(redis.sets.get(setKey) as Set<string>)].find(
      (m) => m !== `elevation:${sha256(live)}`,
    ) as string;
    redis.store.delete(staleMember);
    expect(redis.sets.get(setKey)?.has(staleMember)).toBe(true);

    // The stale member must not throw and must not stop the live grant being
    // revoked alongside it.
    await expect(svc.revokeForAdmin('admin-1')).resolves.toBeUndefined();
    await expect(svc.consume(live, 'admin-1', 'auth.jwtAccessSecret')).resolves.toBe(false);
    expect(redis.sets.has(setKey)).toBe(false);
  });

  it('keeps an earlier grant revocable after a later issue refreshes the set TTL', async () => {
    const redis = withPipeline(fakeRedis());
    const svc = new ElevationService(redis as never);
    const first = await svc.issue('admin-1', 'auth.jwtAccessSecret');

    // 60s later a second grant is issued. The set must be re-expired to a full
    // TTL, otherwise it dies at t=120 while the second grant lives to t=180 --
    // and revokeForAdmin would silently miss it.
    await svc.issue('admin-1', 'redis.url');

    const setKey = [...redis.sets.keys()].find((k) => k.includes('admin-1')) as string;
    expect(setKey).toBeDefined();
    expect(redis.ttls.get(setKey)).toBe(120);
    // Both members are still indexed, so both are still revocable.
    expect(redis.sets.get(setKey)?.size).toBe(2);

    await svc.revokeForAdmin('admin-1');
    await expect(svc.consume(first, 'admin-1', 'auth.jwtAccessSecret')).resolves.toBe(false);
  });

  it('drops a consumed grant from the admin index so it does not accumulate', async () => {
    const redis = withPipeline(fakeRedis());
    const svc = new ElevationService(redis as never);
    const grant = await svc.issue('admin-1', 'auth.jwtAccessSecret');
    await svc.issue('admin-1', 'redis.url');

    await svc.consume(grant, 'admin-1', 'auth.jwtAccessSecret');

    const setKey = [...redis.sets.keys()].find((k) => k.includes('admin-1')) as string;
    expect(redis.sets.get(setKey)?.size).toBe(1);
  });
});
