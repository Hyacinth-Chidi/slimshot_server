import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import {
  admobConfig,
  appAuthConfig,
  appConfig,
  authConfig,
  backupConfig,
  captionConfig,
  pushConfig,
  cryptoConfig,
  databaseConfig,
  emailConfig,
  r2Config,
  redisConfig,
  uploadConfig,
  validate,
} from './config';
import { AuditModule } from './core/audit/audit.module';
import { RedisModule } from './core/cache/redis.module';
import { HealthModule } from './core/health/health.module';
import { IdentityModule } from './core/identity/identity.module';
import { QueueModule } from './core/queue/queue.module';
import { StorageModule } from './core/storage/storage.module';
import { AccountsModule } from './modules/accounts/accounts.module';
import { AdminModule } from './modules/admin/admin.module';
import { AssetsModule } from './modules/assets/assets.module';
import { AuthModule } from './modules/auth/auth.module';
import { BackupsModule } from './modules/backups/backups.module';
import { PushModule } from './modules/push/push.module';
import { CaptionsModule } from './modules/captions/captions.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { CreditsModule } from './modules/credits/credits.module';
import { DevicesModule } from './modules/devices/devices.module';
import { IngestModule } from './modules/ingest/ingest.module';
import { TaxonomyModule } from './modules/taxonomy/taxonomy.module';
import { RewardsModule } from './modules/rewards/rewards.module';
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
        r2Config,
        cryptoConfig,
        captionConfig,
        appAuthConfig,
        emailConfig,
        admobConfig,
        backupConfig,
        pushConfig,
      ],
    }),
    PrismaModule,
    RedisModule,
    QueueModule,
    StorageModule,
    AuditModule,
    IdentityModule,
    HealthModule,
    AuthModule,
    AssetsModule,
    IngestModule,
    TaxonomyModule,
    CatalogModule,
    AdminModule,
    DevicesModule,
    AccountsModule,
    CreditsModule,
    RewardsModule,
    CaptionsModule,
    BackupsModule,
    PushModule,
  ],
})
export class AppModule {}
