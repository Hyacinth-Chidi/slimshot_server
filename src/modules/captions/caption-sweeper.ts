import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { captionConfig, type CaptionConfig } from '../../config';
import { CAPTION_JOB_ID, type CaptionJobData, QUEUE_CAPTIONS } from './captions.constants';

const SWEEP_INTERVAL_MS = 60_000;
const AUDIO_SUFFIX = '.audio';
const FINISHED_STATES = new Set(['completed', 'failed', 'unknown']);

/** Only files CaptionsService wrote: `<jobId>.audio`. Anything else in the directory is not ours. */
function jobIdOf(name: string): string | null {
  if (!name.endsWith(AUDIO_SUFFIX)) return null;
  const jobId = name.slice(0, -AUDIO_SUFFIX.length);
  return CAPTION_JOB_ID.test(jobId) ? jobId : null;
}

/**
 * The backstop behind the worker's own cleanup. On boot and every minute it
 * deletes temp audio older than CAPTION_RESULT_TTL_SECONDS (left by a crash
 * mid-job), and prunes finished jobs past the same age, which BullMQ would
 * otherwise only prune when another job finishes.
 */
@Injectable()
export class CaptionSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CaptionSweeper.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(captionConfig.KEY) private readonly cfg: CaptionConfig,
    @InjectQueue(QUEUE_CAPTIONS) private readonly queue: Queue<CaptionJobData>,
  ) {}

  async onModuleInit(): Promise<void> {
    // Failing here (bad path, no permission) should stop the boot: uploads would fail anyway.
    await mkdir(this.cfg.tmpDir, { recursive: true, mode: 0o700 });
    // Not awaited: BullMQ calls wait for Redis indefinitely, and a Redis outage
    // must not stop the whole API from starting.
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(now = Date.now()): Promise<void> {
    const maxAgeMs = this.cfg.resultTtlSeconds * 1_000;
    try {
      await this.sweepFiles(now, maxAgeMs);
      await this.queue.clean(maxAgeMs, 1_000, 'completed');
      await this.queue.clean(maxAgeMs, 1_000, 'failed');
    } catch (err) {
      // A failed sweep (Redis blip, a file in use) must not take the server down; the next one retries.
      this.logger.warn(`Caption sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async sweepFiles(now: number, maxAgeMs: number): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.cfg.tmpDir);
    } catch {
      return;
    }

    for (const name of names) {
      const jobId = jobIdOf(name);
      if (!jobId) continue;

      const path = join(this.cfg.tmpDir, name);
      const info = await stat(path).catch(() => null);
      if (!info?.isFile() || now - info.mtimeMs <= maxAgeMs) continue;

      // Old is not enough: a job still waiting behind a long queue needs its audio.
      const job = await this.queue.getJob(jobId);
      if (job && !FINISHED_STATES.has(await job.getState())) continue;

      await rm(path, { force: true });
    }
  }
}
