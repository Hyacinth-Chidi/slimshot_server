import { createReadStream } from 'node:fs';
import { access, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';

import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';

import { speechConfig, type SpeechConfig } from '../../config';
import { ErrorCode } from '../../core/errors/error-codes';
import { probeAudio } from '../../core/storage/audio-probe';
import type { ProviderKind } from '../../generated/prisma/enums';
import { FeatureRefunds } from '../credits/feature-refunds';
import { ProviderCredentialsService } from '../providers/provider-credentials.service';
import { ProviderError, scrub } from '../providers/provider-error';
import {
  encodeFailure,
  itemPath,
  jobDir,
  QUEUE_SPEECH,
  type SpeechJobData,
  type SpeechJobResult,
  type SpokenItem,
} from './speech.constants';

@Processor(QUEUE_SPEECH)
export class SpeechWorker extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(SpeechWorker.name);

  constructor(
    private readonly credentials: ProviderCredentialsService,
    private readonly refunds: FeatureRefunds,
    @Inject(speechConfig.KEY) private readonly cfg: SpeechConfig,
  ) {
    super();
  }

  /** @Processor options are static; the concurrency comes from .env, so it is applied once the worker exists. */
  onApplicationBootstrap(): void {
    this.worker.concurrency = this.cfg.concurrency;
  }

  /** Speaks every text in order, one MP3 each; all of them or none, and the charge back with none. */
  async process(job: Job<SpeechJobData, SpeechJobResult>): Promise<SpeechJobResult> {
    const { userId, credits, providerVoiceId, items } = job.data;
    const jobId = String(job.id);
    const dir = jobDir(this.cfg.tmpDir, jobId);
    let failedForGood = false;
    // Kept outside the try so the catch can scrub it from anything it logs.
    let apiKey = '';

    try {
      // Resolved per job, not per request: a provider switched or turned off
      // while the job waited applies to it.
      const active = await this.credentials.getActiveTextToSpeech();
      apiKey = active?.apiKey ?? '';
      if (!active) {
        failedForGood = true;
        throw new UnrecoverableError(encodeFailure(ErrorCode.TTS_UNAVAILABLE, 'No voice provider is active.'));
      }

      await mkdir(dir, { recursive: true, mode: 0o700 });
      const spoken: SpokenItem[] = [];
      for (const item of items) {
        const path = itemPath(this.cfg.tmpDir, jobId, item.id);
        // A retry after an outage keeps what the first attempt already paid the provider for.
        if (!(await exists(path))) {
          const audio = await active.adapter.synthesize({ text: item.text, voiceId: providerVoiceId }, active.apiKey);
          // Whole or not at all: only a finished file ever has the name a retry and a download look for.
          await writeFile(`${path}.part`, audio, { mode: 0o600 });
          await rename(`${path}.part`, path);
        }
        spoken.push({ id: item.id, durationSeconds: await lengthOf(path, active.adapter.kind) });
      }
      return { items: spoken };
    } catch (err) {
      if (err instanceof UnrecoverableError) throw err;

      if (err instanceof ProviderError && !err.retryable) {
        failedForGood = true;
        this.logger.warn(`Speech job ${jobId} refused by ${err.provider} (${err.status}): ${err.message}`);
        throw new UnrecoverableError(encodeFailure(ErrorCode.PROVIDER_FAILED, err.message));
      }

      const attempt = job.attemptsMade + 1;
      failedForGood = attempt >= (job.opts.attempts ?? 1);
      // Network and header errors from fetch can quote request details, key included.
      const reason = scrub(err instanceof Error ? err.message : String(err), apiKey);
      this.logger.warn(`Speech job ${jobId} attempt ${attempt} failed: ${reason}`);
      throw new Error(
        encodeFailure(
          ErrorCode.PROVIDER_FAILED,
          err instanceof ProviderError ? err.message : 'The voice provider could not be reached.',
        ),
      );
    } finally {
      if (failedForGood) {
        // A cleanup problem is logged, never allowed to keep the credits from going back.
        await rm(dir, { recursive: true, force: true }).catch((e: unknown) =>
          this.logger.warn(`Could not delete the voices of job ${jobId}: ${e instanceof Error ? e.message : String(e)}`),
        );
        await this.refunds.refund(userId, jobId, credits, 'job_failed');
      }
    }
  }
}

/**
 * How long a voice plays, read from the MP3's frames — what the app places on
 * its timeline. A file that cannot be read is deleted and reported as the
 * provider's fault, so the one retry asks for it again.
 */
async function lengthOf(path: string, provider: ProviderKind): Promise<number> {
  try {
    const { size } = await stat(path);
    const { durationMs } = await probeAudio(createReadStream(path), size);
    return durationMs / 1_000;
  } catch {
    await rm(path, { force: true });
    throw new ProviderError(provider, 502, 'The voice provider sent audio that could not be read.');
  }
}

function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
