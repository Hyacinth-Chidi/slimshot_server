import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';

import { captionConfig, type CaptionConfig } from '../../config';
import { DevicesModule } from '../devices/devices.module';
import { ProvidersModule } from '../providers/providers.module';
import { CaptionSweeper } from './caption-sweeper';
import { CaptionWorker } from './caption.worker';
import { QUEUE_CAPTIONS } from './captions.constants';
import { CaptionsController } from './captions.controller';
import { CaptionsService } from './captions.service';

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUE_CAPTIONS }),
    // No storage or dest: multer keeps the upload in memory, and the service
    // writes it to CAPTION_TMP_DIR only once the request has passed every check.
    MulterModule.registerAsync({
      inject: [captionConfig.KEY],
      useFactory: (caption: CaptionConfig) => ({
        limits: { fileSize: caption.maxUploadBytes, files: 1 },
      }),
    }),
    DevicesModule,
    ProvidersModule,
  ],
  controllers: [CaptionsController],
  providers: [CaptionsService, CaptionWorker, CaptionSweeper],
})
export class CaptionsModule {}
