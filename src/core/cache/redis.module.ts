import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';

import { redisConfig, type RedisConfig } from '../../config';
import { CacheService, REDIS } from './cache.service';
import { createRedisClient } from './redis-client';

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [redisConfig.KEY],
      useFactory: (redis: RedisConfig): Redis => createRedisClient(redis.url),
    },
    CacheService,
  ],
  exports: [CacheService, REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}
