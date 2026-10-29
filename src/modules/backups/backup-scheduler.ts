import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';

import {
  BACKUP_CHECK_PATTERN,
  BACKUP_CHECK_SCHEDULER,
  BACKUP_CHECK_TZ,
  JOB_CHECK,
  QUEUE_BACKUPS,
} from './backups.constants';
import { BackupsService } from './backups.service';

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * On boot: clears temp dumps a crash left behind, then puts the daily check on the queue
 * when backups are set up, or takes it off when they are not (a server whose bucket was
 * removed must stop trying).
 */
@Injectable()
export class BackupScheduler implements OnModuleInit {
  private readonly logger = new Logger(BackupScheduler.name);

  constructor(
    private readonly backups: BackupsService,
    @InjectQueue(QUEUE_BACKUPS) private readonly queue: Queue,
  ) {}

  onModuleInit(): void {
    // Not awaited: BullMQ calls wait for Redis indefinitely, and a Redis outage
    // must not stop the whole API from starting.
    void this.sync();
  }

  async sync(): Promise<void> {
    try {
      await this.backups.removeLeftovers();
    } catch (err) {
      this.logger.warn(`Could not clear old backup files: ${reason(err)}`);
    }
    try {
      if (this.backups.availability() === 'ready') {
        await this.queue.upsertJobScheduler(
          BACKUP_CHECK_SCHEDULER,
          { pattern: BACKUP_CHECK_PATTERN, tz: BACKUP_CHECK_TZ },
          { name: JOB_CHECK, opts: { removeOnComplete: true, removeOnFail: true } },
        );
      } else {
        await this.queue.removeJobScheduler(BACKUP_CHECK_SCHEDULER);
      }
    } catch (err) {
      this.logger.warn(`Could not schedule the daily backup check: ${reason(err)}`);
    }
  }
}
