import { CacheService } from './cache.service';

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    }),
    del: jest.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
    incr: jest.fn(async (k: string) => {
      const next = Number(store.get(k) ?? '0') + 1;
      store.set(k, String(next));
      return next;
    }),
  };
}

describe('CacheService', () => {
  it('calls the factory on a miss and returns its value', async () => {
    const svc = new CacheService(fakeRedis() as never);
    const factory = jest.fn().mockResolvedValue({ n: 1 });
    await expect(svc.wrap('audio', { page: 1 }, factory, 60)).resolves.toEqual({ n: 1 });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('does not call the factory twice for the same key', async () => {
    const svc = new CacheService(fakeRedis() as never);
    const factory = jest.fn().mockResolvedValue({ n: 1 });
    await svc.wrap('audio', { page: 1 }, factory, 60);
    await svc.wrap('audio', { page: 1 }, factory, 60);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('treats different key parts as different entries', async () => {
    const svc = new CacheService(fakeRedis() as never);
    const factory = jest.fn().mockResolvedValue({ n: 1 });
    await svc.wrap('audio', { page: 1 }, factory, 60);
    await svc.wrap('audio', { page: 2 }, factory, 60);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('is insensitive to key-part property order', async () => {
    const svc = new CacheService(fakeRedis() as never);
    const factory = jest.fn().mockResolvedValue({ n: 1 });
    await svc.wrap('audio', { a: 1, b: 2 }, factory, 60);
    await svc.wrap('audio', { b: 2, a: 1 }, factory, 60);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('orphans every entry in a namespace when the generation is bumped', async () => {
    const svc = new CacheService(fakeRedis() as never);
    const factory = jest.fn().mockResolvedValue({ n: 1 });

    await svc.wrap('audio', { page: 1 }, factory, 60);
    await svc.bumpGeneration('audio');
    await svc.wrap('audio', { page: 1 }, factory, 60);

    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('bumping one namespace leaves another namespace cached', async () => {
    const svc = new CacheService(fakeRedis() as never);
    const audio = jest.fn().mockResolvedValue({ n: 1 });
    const fonts = jest.fn().mockResolvedValue({ n: 2 });

    await svc.wrap('audio', { page: 1 }, audio, 60);
    await svc.wrap('font', { page: 1 }, fonts, 60);
    await svc.bumpGeneration('audio');
    await svc.wrap('font', { page: 1 }, fonts, 60);

    expect(fonts).toHaveBeenCalledTimes(1);
  });

  it('returns the factory value rather than throwing when redis read fails', async () => {
    const redis = fakeRedis();
    redis.get.mockRejectedValue(new Error('ECONNREFUSED'));
    const svc = new CacheService(redis as never);
    const factory = jest.fn().mockResolvedValue({ n: 9 });

    await expect(svc.wrap('audio', { page: 1 }, factory, 60)).resolves.toEqual({ n: 9 });
  });
});
