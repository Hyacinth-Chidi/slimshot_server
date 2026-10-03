import { rm } from 'node:fs/promises';

import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';

import { captionConfig, type CaptionConfig } from '../../config';
import { ErrorCode } from '../../core/errors/error-codes';
import { ProviderCapability } from '../../generated/prisma/enums';
import { ProviderCredentialsService } from '../providers/provider-credentials.service';
import { ProviderError, scrub } from '../providers/provider-error';
import type { CaptionResult } from '../providers/speech-to-text.provider';
import { CaptionRefunds } from './caption-refunds';
import { type CaptionJobData, encodeFailure, QUEUE_CAPTIONS } from './captions.constants';

@Processor(QUEUE_CAPTIONS)
export class CaptionWorker extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(CaptionWorker.name);

  constructor(
    private readonly credentials: ProviderCredentialsService,
    private readonly refunds: CaptionRefunds,
    @Inject(captionConfig.KEY) private readonly cfg: CaptionConfig,
  ) {
    super();
  }

  /** @Processor options are static; the concurrency comes from .env, so it is applied once the worker exists. */
  onApplicationBootstrap(): void {
    this.worker.concurrency = this.cfg.concurrency;
  }

  async process(job: Job<CaptionJobData, CaptionResult>): Promise<CaptionResult> {
    const { filePath, mimeType, language, userId, credits } = job.data;
    // The audio goes the moment it cannot be needed again; a job that will not
    // be retried gives its credits back.
    let audioDone = false;
    let failedForGood = false;
    // Kept outside the try so the catch can scrub it from anything it logs.
    let apiKey = '';

    try {
      // Resolved per job, not per upload: a provider switched or turned off
      // while the job waited applies to it.
      const active = await this.credentials.getActive(ProviderCapability.speech_to_text);
      apiKey = active?.apiKey ?? '';
      if (!active) {
        audioDone = true;
        failedForGood = true;
        throw new UnrecoverableError(encodeFailure(ErrorCode.CAPTIONS_UNAVAILABLE, 'No caption provider is active.'));
      }

      const result = await active.adapter.transcribe(
        { filePath, mimeType, language: language ?? undefined },
        active.apiKey,
      );
      audioDone = true;
      return result;
    } catch (err) {
      if (err instanceof UnrecoverableError) throw err;

      if (err instanceof ProviderError && !err.retryable) {
        audioDone = true;
        failedForGood = true;
        this.logger.warn(`Caption job ${job.id} refused by ${err.provider} (${err.status}): ${err.message}`);
        throw new UnrecoverableError(encodeFailure(ErrorCode.PROVIDER_FAILED, err.message));
      }

      const attempt = job.attemptsMade + 1;
      audioDone = attempt >= (job.opts.attempts ?? 1);
      failedForGood = audioDone;
      // Network and header errors from fetch can quote request details, key included.
      const reason = scrub(err instanceof Error ? err.message : String(err), apiKey);
      this.logger.warn(`Caption job ${job.id} attempt ${attempt} failed: ${reason}`);
      throw new Error(
        encodeFailure(
          ErrorCode.PROVIDER_FAILED,
          err instanceof ProviderError ? err.message : 'The caption provider could not be reached.',
        ),
      );
    } finally {
      // A cleanup problem must never turn a paid answer into a failure (and a second provider call).
      if (audioDone) {
        await rm(filePath, { force: true }).catch((e: unknown) =>
          this.logger.warn(
            `Could not delete caption audio for job ${job.id}: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
      }
      if (failedForGood) await this.refunds.refund(userId, String(job.id), credits, 'job_failed');
    }
  }
}
