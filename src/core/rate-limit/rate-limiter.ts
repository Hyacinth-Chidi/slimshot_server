import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';

import { REDIS } from '../cache/cache.service';
import { appError } from '../errors/app-error';
import { ErrorCode } from '../errors/error-codes';

/** Fixed-window counters in Redis. */
@Injectable()
export class RateLimiter {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async increment(key: string, windowSeconds: number): Promise<number> {
    const k = `rl:${key}`;
    const count = await this.redis.incr(k);
    // Start the window on the first count, and repair a counter left without an expiry (it
    // expired between two commands, or the process died between them): no one is limited for good.
    if (count === 1 || (await this.redis.ttl(k)) === -1) await this.redis.expire(k, windowSeconds);
    return count;
  }

  async hit(key: string, limit: number, windowSeconds: number): Promise<void> {
    if ((await this.increment(key, windowSeconds)) <= limit) return;
    const ttl = await this.redis.ttl(`rl:${key}`);
    throw appError(HttpStatus.TOO_MANY_REQUESTS, ErrorCode.RATE_LIMITED, 'Too many requests. Try again later.', {
      retryAfterSeconds: ttl > 0 ? ttl : windowSeconds,
    });
  }
}
