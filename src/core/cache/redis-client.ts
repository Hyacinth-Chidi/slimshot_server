import { Redis } from 'ioredis';

/**
 * The shared client for cache, rate limits, OTP and sign-in attempts. It fails
 * fast when Redis is down: one retry, then the command errors, and a command on
 * a stalled connection gives up after a second. With ioredis's default
 * (`maxRetriesPerRequest: null`) every command would wait for Redis to come
 * back, so callers built to carry on without Redis (the cache, the public
 * catalogue's rate limit) would hang instead. BullMQ builds its own connection
 * and is not affected.
 */
export function createRedisClient(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: 1, commandTimeout: 1_000 });
}
