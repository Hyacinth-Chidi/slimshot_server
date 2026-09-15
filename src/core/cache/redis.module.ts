import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';

import { SettingsService } from '../settings/settings.service';
import { CacheService, REDIS } from './cache.service';

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [SettingsService],
      useFactory: async (settings: SettingsService): Promise<Redis> => {
        const url = await settings.get<string>('redis.url');
        return new Redis(url, { maxRetriesPerRequest: null });
      },
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
