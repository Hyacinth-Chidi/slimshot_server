import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';

import { SettingsService } from '../settings/settings.service';
import { QUEUE_ASSET_PROCESSING } from './queue.constants';
import { QueueService } from './queue.service';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [SettingsService],
      useFactory: async (settings: SettingsService) => ({
        connection: { url: await settings.get<string>('redis.url') },
      }),
    }),
    BullModule.registerQueue({ name: QUEUE_ASSET_PROCESSING }),
  ],
  providers: [QueueService],
  exports: [QueueService, BullModule],
})
export class QueueModule {}
