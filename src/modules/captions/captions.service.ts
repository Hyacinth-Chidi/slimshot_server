import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { InjectQueue } from '@nestjs/bullmq';
import {
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Job, Queue } from 'bullmq';

import { captionConfig, type CaptionConfig } from '../../config';
import { ErrorCode } from '../../core/errors/error-codes';
import { ProviderCapability } from '../../generated/prisma/enums';
import type { AuthenticatedDevice } from '../devices/devices.service';
import { ProviderCredentialsService } from '../providers/provider-credentials.service';
import type { CaptionResult } from '../providers/speech-to-text.provider';
import {
  CAPTION_JOB_ID,
  captionJobId,
  type CaptionJobData,
  type CaptionJobView,
  decodeFailure,
  POLL_AFTER_MS,
  QUEUE_CAPTIONS,
} from './captions.constants';

export interface UploadedAudio {
  buffer: Buffer;
  mimetype: string;
}

type CaptionJob = Job<CaptionJobData, CaptionResult>;

@Injectable()
export class CaptionsService {
  constructor(
    @InjectQueue(QUEUE_CAPTIONS) private readonly queue: Queue<CaptionJobData, CaptionResult>,
    private readonly credentials: ProviderCredentialsService,
    @Inject(captionConfig.KEY) private readonly cfg: CaptionConfig,
  ) {}

  async start(
    device: AuthenticatedDevice,
    audio: UploadedAudio,
    language: string | undefined,
    idempotencyKey: string,
  ): Promise<CaptionJobView> {
    // Credit phase: the balance check belongs here, before anything is written or queued.
    if (!(await this.credentials.getActive(ProviderCapability.speech_to_text))) {
      throw new ServiceUnavailableException({
        code: ErrorCode.CAPTIONS_UNAVAILABLE,
        message: 'Auto caption is not available right now. Try again later.',
      });
    }

    const jobId = captionJobId(device.id, idempotencyKey);
    const existing = await this.queue.getJob(jobId);
    // A resend of an upload the server already has: answer with that job and
    // drop the new bytes without writing them.
    if (existing) return this.view(existing);

    await mkdir(this.cfg.tmpDir, { recursive: true, mode: 0o700 });
    const filePath = join(this.cfg.tmpDir, `${jobId}.audio`);
    await writeFile(filePath, audio.buffer, { mode: 0o600 });

    try {
      await this.queue.add(
        'transcribe',
        { deviceId: device.id, filePath, mimeType: audio.mimetype, language: language ?? null },
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
      await rm(filePath, { force: true });
      throw err;
    }

    return { jobId, status: 'queued', pollAfterMs: POLL_AFTER_MS };
  }

  async status(device: AuthenticatedDevice, jobId: string): Promise<CaptionJobView> {
    if (!CAPTION_JOB_ID.test(jobId)) throw notFound();

    const job = await this.queue.getJob(jobId);
    if (!job || job.data.deviceId !== device.id) throw notFound();

    // BullMQ prunes finished jobs by age only when a later job finishes. The
    // app is promised a fixed window, so enforce it here.
    if (job.finishedOn && Date.now() - job.finishedOn > this.cfg.resultTtlSeconds * 1_000) {
      throw notFound();
    }

    return this.view(job);
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
