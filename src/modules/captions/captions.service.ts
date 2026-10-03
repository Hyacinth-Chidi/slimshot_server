import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { InjectQueue } from '@nestjs/bullmq';
import { HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';

import { captionConfig, type CaptionConfig } from '../../config';
import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { AccountStatus, CreditFeature, CreditTxType, ProviderCapability } from '../../generated/prisma/enums';
import type { AuthenticatedAppUser } from '../accounts/user-auth.guard';
import { LedgerService } from '../credits/ledger.service';
import { PricingService } from '../credits/pricing.service';
import { ProviderCredentialsService } from '../providers/provider-credentials.service';
import type { CaptionResult } from '../providers/speech-to-text.provider';
import { CaptionRefunds } from './caption-refunds';
import {
  CAPTION_JOB_ID,
  captionJobId,
  type CaptionJobData,
  type CaptionJobView,
  decodeFailure,
  POLL_AFTER_MS,
  QUEUE_CAPTIONS,
} from './captions.constants';
import { InvalidWavError, wavDurationSeconds } from './wav';

export interface UploadedAudio {
  buffer: Buffer;
  mimetype: string;
}

export type StartedCaptionView = CaptionJobView & { charged?: { credits: number; balance: number } };

/** WAV only: the server measures the duration from the header, never from the app. */
export const WAV_MIME_TYPES = new Set(['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave']);

type CaptionJob = Job<CaptionJobData, CaptionResult>;

@Injectable()
export class CaptionsService {
  constructor(
    @InjectQueue(QUEUE_CAPTIONS) private readonly queue: Queue<CaptionJobData, CaptionResult>,
    private readonly providers: ProviderCredentialsService,
    private readonly pricing: PricingService,
    private readonly ledger: LedgerService,
    private readonly refunds: CaptionRefunds,
    @Inject(captionConfig.KEY) private readonly cfg: CaptionConfig,
  ) {}

  async start(
    user: AuthenticatedAppUser,
    audio: UploadedAudio,
    language: string | undefined,
    idempotencyKey: string,
  ): Promise<StartedCaptionView> {
    if (user.status === AccountStatus.suspended) {
      throw appError(HttpStatus.FORBIDDEN, ErrorCode.ACCOUNT_SUSPENDED, 'This account is suspended. Contact support.');
    }
    if (!(await this.providers.getActive(ProviderCapability.speech_to_text))) {
      throw appError(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.CAPTIONS_UNAVAILABLE,
        'Auto caption is not available right now. Try again later.',
      );
    }

    const jobId = captionJobId(user.id, idempotencyKey);
    const existing = await this.queue.getJob(jobId);
    // A resend of an upload the server already has: same job, no second charge.
    if (existing) return this.view(existing);

    if (!WAV_MIME_TYPES.has(audio.mimetype)) {
      throw appError(
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        ErrorCode.UNSUPPORTED_MEDIA,
        `Upload WAV audio (audio/wav); got ${audio.mimetype}.`,
      );
    }
    const durationSeconds = this.measure(audio.buffer);
    const { credits, rule } = await this.pricing.price(CreditFeature.auto_captions, durationSeconds);

    let charged: { credits: number; balance: number } | undefined;
    if (credits > 0) {
      // Held before any provider call; the worker refunds it if the job fails.
      const { transaction } = await this.ledger.post({
        userId: user.id,
        type: CreditTxType.feature_charge,
        amount: -credits,
        reference: jobId,
        requireActive: true,
        metadata: {
          feature: CreditFeature.auto_captions,
          durationSeconds,
          pricingRuleId: rule.id,
          pricingVersion: rule.version,
        },
      });
      charged = { credits, balance: transaction.balanceAfter };
    }

    const filePath = join(this.cfg.tmpDir, `${jobId}.audio`);
    try {
      await mkdir(this.cfg.tmpDir, { recursive: true, mode: 0o700 });
      await writeFile(filePath, audio.buffer, { mode: 0o600 });
      await this.queue.add(
        'transcribe',
        { userId: user.id, filePath, mimeType: audio.mimetype, language: language ?? null, credits },
        {
          jobId,
          // The retry is for outages only; the worker makes refusals unrecoverable.
          attempts: 2,
          backoff: { type: 'fixed', delay: 2_000 },
          removeOnComplete: { age: this.cfg.resultTtlSeconds },
          removeOnFail: { age: this.cfg.resultTtlSeconds },
        },
      );
    } catch (err) {
      await rm(filePath, { force: true }).catch(() => undefined);
      await this.refunds.refund(user.id, jobId, credits, 'queue_failed');
      throw err;
    }

    return { jobId, status: 'queued', pollAfterMs: POLL_AFTER_MS, ...(charged ? { charged } : {}) };
  }

  async status(user: AuthenticatedAppUser, jobId: string): Promise<CaptionJobView> {
    if (!CAPTION_JOB_ID.test(jobId)) throw notFound();
    const job = await this.queue.getJob(jobId);
    if (!job || job.data.userId !== user.id) throw notFound();
    // BullMQ prunes finished jobs by age only when a later job finishes. The
    // app is promised a fixed window, so enforce it here.
    if (job.finishedOn && Date.now() - job.finishedOn > this.cfg.resultTtlSeconds * 1_000) throw notFound();
    return this.view(job);
  }

  private measure(audio: Buffer): number {
    try {
      return wavDurationSeconds(audio);
    } catch (err) {
      if (err instanceof InvalidWavError) {
        throw appError(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.INVALID_AUDIO, err.message);
      }
      throw err;
    }
  }

  private async view(job: CaptionJob): Promise<CaptionJobView> {
    const jobId = String(job.id);
    const state = await job.getState();
    switch (state) {
      case 'completed':
        return { jobId, status: 'completed', result: job.returnvalue };
      case 'failed':
        return { jobId, status: 'failed', error: decodeFailure(job.failedReason) };
      case 'active':
        return { jobId, status: 'processing', pollAfterMs: POLL_AFTER_MS };
      case 'unknown':
        throw notFound();
      default:
        return { jobId, status: 'queued', pollAfterMs: POLL_AFTER_MS };
    }
  }
}

function notFound(): NotFoundException {
  return new NotFoundException(
    'No caption job with this id. Finished results expire a few minutes after they are ready.',
  );
}
