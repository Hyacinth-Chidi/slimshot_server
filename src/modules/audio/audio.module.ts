import { Module } from '@nestjs/common';

import { AudioController } from './audio.controller';
import { AudioService } from './audio.service';
import { CloudinaryAudioService } from './providers/cloudinary-audio.service';

@Module({
  controllers: [AudioController],
  providers: [AudioService, CloudinaryAudioService],
})
export class AudioModule {}
