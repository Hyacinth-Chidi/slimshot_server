import { getQueueToken } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { backupConfig, databaseConfig, r2Config } from '../../config';
import { AuditService } from '../../core/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BackupScheduler } from './backup-scheduler';
import { BackupWorker } from './backup.worker';
import { BACKUP_RUNTIME, BACKUP_STORE, QUEUE_BACKUPS } from './backups.constants';
import { BackupsModule } from './backups.module';
import { BackupsService } from './backups.service';

// Stand-ins for the app's global Prisma and audit modules.
@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: {} },
    { provide: AuditService, useValue: {} },
  ],
  exports: [PrismaService, AuditService],
})
class CoreStandIns {}

describe('BackupsModule', () => {
  // A wiring mistake would only show when the API starts in production, after the old
  // container is gone. This builds the module with real DI (the queue stood in: no Redis).
  it('resolves its service, worker and scheduler, and has no bucket outside production', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [backupConfig, databaseConfig, r2Config] }),
        CoreStandIns,
        BackupsModule,
      ],
    })
      .overrideProvider(getQueueToken(QUEUE_BACKUPS))
      .useValue({})
      .compile();

    expect(moduleRef.get(BackupsService)).toBeInstanceOf(BackupsService);
    expect(moduleRef.get(BackupWorker)).toBeInstanceOf(BackupWorker);
    expect(moduleRef.get(BackupScheduler)).toBeInstanceOf(BackupScheduler);
    expect(moduleRef.get(BACKUP_STORE)).toBeNull();
    expect(moduleRef.get(BACKUP_RUNTIME)).toMatchObject({ tmpDir: expect.stringContaining('slimshot-backups') });
    expect(moduleRef.get(BackupsService).availability()).toBe('not-production');
    await moduleRef.close();
  });
});
