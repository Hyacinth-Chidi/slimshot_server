import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { CryptoModule } from './core/crypto/crypto.module';
import { SettingsModule } from './core/settings/settings.module';
import { StorageModule } from './core/storage/storage.module';
import { AudioModule } from './modules/audio/audio.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
    }),
    CacheModule.register({
      isGlobal: true,
    }),
    PrismaModule,
    CryptoModule,
    SettingsModule,
    StorageModule,
    AudioModule,
  ],
})
export class AppModule {}
