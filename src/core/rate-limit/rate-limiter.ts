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
    // SET NX first, so the key carries its expiry before it is ever counted.
    await this.redis.set(k, '0', 'EX', windowSeconds, 'NX');
    return this.redis.incr(k);
  }

  async hit(key: string, limit: number, windowSeconds: number): Promise<void> {
    if ((await this.increment(key, windowSeconds)) <= limit) return;
    const ttl = await this.redis.ttl(`rl:${key}`);
    throw appError(HttpStatus.TOO_MANY_REQUESTS, ErrorCode.RATE_LIMITED, 'Too many requests. Try again later.', {
      retryAfterSeconds: ttl > 0 ? ttl : windowSeconds,
    });
  }
}
