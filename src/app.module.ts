import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import {
  appConfig,
  authConfig,
  captionConfig,
  cloudinaryConfig,
  cryptoConfig,
  databaseConfig,
  redisConfig,
  uploadConfig,
  validate,
} from './config';
import { AuditModule } from './core/audit/audit.module';
import { RedisModule } from './core/cache/redis.module';
import { HealthModule } from './core/health/health.module';
import { QueueModule } from './core/queue/queue.module';
import { StorageModule } from './core/storage/storage.module';
import { AdminModule } from './modules/admin/admin.module';
import { AssetsModule } from './modules/assets/assets.module';
import { AuthModule } from './modules/auth/auth.module';
import { DevicesModule } from './modules/devices/devices.module';
import { IngestModule } from './modules/ingest/ingest.module';
import { TaxonomyModule } from './modules/taxonomy/taxonomy.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
      validate,
      load: [
        appConfig,
        databaseConfig,
        redisConfig,
        authConfig,
        uploadConfig,
        cloudinaryConfig,
        cryptoConfig,
        captionConfig,
      ],
    }),
    PrismaModule,
    RedisModule,
    QueueModule,
    StorageModule,
    AuditModule,
    HealthModule,
    AuthModule,
    AssetsModule,
    IngestModule,
    TaxonomyModule,
    AdminModule,
    DevicesModule,
  ],
})
export class AppModule {}
