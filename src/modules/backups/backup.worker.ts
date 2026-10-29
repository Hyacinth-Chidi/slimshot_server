import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import { type BackupRunJob, JOB_CHECK, JOB_RUN, QUEUE_BACKUPS } from './backups.constants';
import { BackupsService } from './backups.service';

/** One job at a time, so two backups never run at once. A failed run is not retried; the next daily check is. */
@Processor(QUEUE_BACKUPS, { concurrency: 1 })
export class BackupWorker extends WorkerHost {
  private readonly logger = new Logger(BackupWorker.name);

  constructor(private readonly backups: BackupsService) {
    super();
  }

  async process(job: Job<BackupRunJob | undefined>): Promise<string> {
    try {
      if (job.name === JOB_CHECK) return await this.backups.runScheduledCheck();
      if (job.name === JOB_RUN && job.data) {
        const { filename } = await this.backups.runBackup(job.data.trigger, job.data.actor);
        return filename;
      }
      throw new Error(`Unknown backup job "${job.name}"`);
    } catch (err) {
      // runBackup has already recorded and audited the failure, the password scrubbed.
      this.logger.warn(`Backup job ${job.name} failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }
}
