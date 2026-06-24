import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';

import { AudioController } from './audio.controller';
import { AudioService } from './audio.service';
import { PixabayService } from './providers/pixabay.service';

@Module({
  imports: [
    HttpModule.register({
      timeout: 10000,
      maxRedirects: 5,
    }),
  ],
  controllers: [AudioController],
  providers: [AudioService, PixabayService],
})
export class AudioModule {}
