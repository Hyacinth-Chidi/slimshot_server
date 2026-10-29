import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { backupConfig, type BackupConfig, r2Config, type R2EnvConfig } from '../../config';
import { BackupScheduler } from './backup-scheduler';
import { BackupStore } from './backup-store';
import { BackupWorker } from './backup.worker';
import { BACKUP_RUNTIME, BACKUP_STORE, DEFAULT_BACKUP_RUNTIME, QUEUE_BACKUPS } from './backups.constants';
import { BackupsService } from './backups.service';

@Module({
  imports: [BullModule.registerQueue({ name: QUEUE_BACKUPS })],
  providers: [
    BackupsService,
    BackupWorker,
    BackupScheduler,
    {
      provide: BACKUP_STORE,
      inject: [backupConfig.KEY, r2Config.KEY],
      // Only the live server touches the bucket: a developer's server shares the R2 account.
      useFactory: (backup: BackupConfig, r2: R2EnvConfig): BackupStore | null =>
        backup.production && backup.bucket ? new BackupStore(r2, backup.bucket) : null,
    },
    { provide: BACKUP_RUNTIME, useValue: DEFAULT_BACKUP_RUNTIME },
  ],
  exports: [BackupsService],
})
export class BackupsModule {}
