import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AudioModule } from './modules/audio/audio.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
    }),
    CacheModule.register({
      isGlobal: true,
    }),
    AudioModule,
  ],
})
export class AppModule {}
