import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';

import { AssetProcessingJob, QUEUE_ASSET_PROCESSING } from './queue.constants';

@Injectable()
export class QueueService {
  constructor(
    @InjectQueue(QUEUE_ASSET_PROCESSING) private readonly queue: Queue,
  ) {}

  async enqueueAssetProcessing(job: AssetProcessingJob): Promise<string> {
    const added = await this.queue.add(job.processor, job, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 86_400, count: 1_000 },
      removeOnFail: false, // failures stay visible in the admin jobs endpoint
    });
    return String(added.id);
  }

  async getQueueHealth(): Promise<{
    waiting: number;
    active: number;
    failed: number;
  }> {
    const [waiting, active, failed] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getFailedCount(),
    ]);
    return { waiting, active, failed };
  }
}
