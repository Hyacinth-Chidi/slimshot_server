import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { pushConfig, type PushConfig } from '../../config';
import { DevicesModule } from '../devices/devices.module';
import { FirebasePushSender } from './firebase-sender';
import { PUSH_SENDER, QUEUE_PUSH, type PushSender } from './push.constants';
import { PushController } from './push.controller';
import { PushService } from './push.service';
import { PushWorker } from './push.worker';

@Module({
  imports: [BullModule.registerQueue({ name: QUEUE_PUSH }), DevicesModule],
  controllers: [PushController],
  providers: [
    PushService,
    PushWorker,
    {
      provide: PUSH_SENDER,
      inject: [pushConfig.KEY],
      // Off until FIREBASE_SERVICE_ACCOUNT_BASE64 is set: the dashboard then says how to set it up.
      useFactory: (push: PushConfig): PushSender | null =>
        push.serviceAccount ? new FirebasePushSender(push.serviceAccount) : null,
    },
  ],
  exports: [PushService],
})
export class PushModule {}
