import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AuditModule } from './core/audit/audit.module';
import { RedisModule } from './core/cache/redis.module';
import { CryptoModule } from './core/crypto/crypto.module';
import { HealthModule } from './core/health/health.module';
import { QueueModule } from './core/queue/queue.module';
import { SettingsModule } from './core/settings/settings.module';
import { StorageModule } from './core/storage/storage.module';
import { AdminModule } from './modules/admin/admin.module';
import { AssetsModule } from './modules/assets/assets.module';
import { AuthModule } from './modules/auth/auth.module';
import { IngestModule } from './modules/ingest/ingest.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
    }),
    PrismaModule,
    CryptoModule,
    SettingsModule,
    RedisModule,
    QueueModule,
    StorageModule,
    AuditModule,
    HealthModule,
    AuthModule,
    AssetsModule,
    IngestModule,
    AdminModule,
  ],
})
export class AppModule {}
