import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';

import { redisConfig, type RedisConfig } from '../../config';
import { QUEUE_ASSET_PROCESSING } from './queue.constants';
import { QueueService } from './queue.service';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [redisConfig.KEY],
      useFactory: (redis: RedisConfig) => ({ connection: { url: redis.url } }),
    }),
    BullModule.registerQueue({ name: QUEUE_ASSET_PROCESSING }),
  ],
  providers: [QueueService],
  exports: [QueueService, BullModule],
})
export class QueueModule {}
