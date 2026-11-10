import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { speechConfig, type SpeechConfig } from '../../config';
import { QUEUE_SPEECH, SPEECH_JOB_ID, type SpeechJobData } from './speech.constants';

const SWEEP_INTERVAL_MS = 60_000;
const FINISHED_STATES = new Set(['completed', 'failed']);

/**
 * Deletes the voices the app has had its window to download. On boot and every
 * minute it removes a finished job's folder TTS_KEEP_MINUTES after the job
 * finished — or, for a folder whose job is gone (pruned, or lost with Redis),
 * after its last write — and prunes finished jobs past the same age, which
 * BullMQ would otherwise only prune when another job finishes.
 */
@Injectable()
export class SpeechSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SpeechSweeper.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(speechConfig.KEY) private readonly cfg: SpeechConfig,
    @InjectQueue(QUEUE_SPEECH) private readonly queue: Queue<SpeechJobData>,
  ) {}

  async onModuleInit(): Promise<void> {
    // Failing here (bad path, no permission) should stop the boot: every job would fail anyway.
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
    const keepMs = this.cfg.keepMinutes * 60_000;
    try {
      await this.sweepFolders(now, keepMs);
      await this.queue.clean(keepMs, 1_000, 'completed');
      await this.queue.clean(keepMs, 1_000, 'failed');
    } catch (err) {
      // A failed sweep (Redis blip, a file in use) must not take the server down; the next one retries.
      this.logger.warn(`Speech sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async sweepFolders(now: number, keepMs: number): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.cfg.tmpDir);
    } catch {
      return;
    }

    for (const name of names) {
      // Only folders SpeechWorker made: `<jobId>/`. Anything else in the directory is not ours.
      if (!SPEECH_JOB_ID.test(name)) continue;
      const path = join(this.cfg.tmpDir, name);
      const info = await stat(path).catch(() => null);
      if (!info?.isDirectory()) continue;

      const job = await this.queue.getJob(name);
      const state = job ? await job.getState() : 'unknown';
      if (state !== 'unknown' && !FINISHED_STATES.has(state)) continue; // still waiting or running
      const since = state === 'unknown' ? info.mtimeMs : (job?.finishedOn ?? info.mtimeMs);
      if (now - since <= keepMs) continue;

      await rm(path, { recursive: true, force: true });
    }
  }
}
