import { HttpException } from '@nestjs/common';

import { FakeRedis } from '../../../test/fakes/fake-redis';
import { RateLimiter } from './rate-limiter';

describe('RateLimiter', () => {
  it('allows up to the limit in a window, then answers 429 with the wait', async () => {
    const redis = new FakeRedis();
    const limiter = new RateLimiter(redis as never);
    await limiter.hit('k', 2, 60);
    await limiter.hit('k', 2, 60);

    const error = (await limiter.hit('k', 2, 60).catch((e: unknown) => e)) as HttpException;
    expect(error.getStatus()).toBe(429);
    expect(error.getResponse()).toMatchObject({ code: 'RATE_LIMITED', details: { retryAfterSeconds: 60 } });
  });

  it('starts a fresh window after the old one expires', async () => {
    const redis = new FakeRedis();
    let t = 0;
    redis.now = () => t;
    const limiter = new RateLimiter(redis as never);
    await limiter.hit('k', 1, 60);
    t = 61_000;
    await expect(limiter.hit('k', 1, 60)).resolves.toBeUndefined();
  });

  it('gives a counter that lost its expiry a new one, so nobody is limited for good', async () => {
    const redis = new FakeRedis();
    await redis.set('rl:k', '7');
    await new RateLimiter(redis as never).increment('k', 60);
    expect(await redis.ttl('rl:k')).toBeGreaterThan(0);
  });

  it('counts without throwing when asked to', async () => {
    const limiter = new RateLimiter(new FakeRedis() as never);
    expect(await limiter.increment('ip', 86_400)).toBe(1);
    expect(await limiter.increment('ip', 86_400)).toBe(2);
  });
});
