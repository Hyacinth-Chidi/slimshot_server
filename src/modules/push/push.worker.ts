import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import { QUEUE_PUSH, type PushJob } from './push.constants';
import { PushService } from './push.service';

/** One message at a time; a failed one is recorded on the message, not retried. */
@Processor(QUEUE_PUSH, { concurrency: 1 })
export class PushWorker extends WorkerHost {
  private readonly logger = new Logger(PushWorker.name);

  constructor(private readonly push: PushService) {
    super();
  }

  async process(job: Job<PushJob>): Promise<void> {
    try {
      await this.push.deliver(job.data.messageId);
    } catch (err) {
      this.logger.warn(`Push message ${job.data.messageId} failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }
}
