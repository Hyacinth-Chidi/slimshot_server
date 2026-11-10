import { access } from 'node:fs/promises';

import { InjectQueue } from '@nestjs/bullmq';
import { HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';

import { speechConfig, type SpeechConfig } from '../../config';
import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { AccountStatus, CreditFeature, CreditTxType } from '../../generated/prisma/enums';
import type { AuthenticatedAppUser } from '../accounts/user-auth.guard';
import { FeatureRefunds } from '../credits/feature-refunds';
import { LedgerService } from '../credits/ledger.service';
import { countCharacters } from '../credits/pricing';
import { PricingService } from '../credits/pricing.service';
import { ProviderCredentialsService } from '../providers/provider-credentials.service';
import { VoicesService } from '../voices/voices.service';
import {
  decodeFailure,
  ITEM_ID,
  itemPath,
  QUEUE_SPEECH,
  SPEECH_JOB_ID,
  SPEECH_POLL_AFTER_MS,
  speechJobId,
  type SpeechItem,
  type SpeechJobData,
  type SpeechJobResult,
  type SpeechJobView,
} from './speech.constants';

export interface StartSpeech {
  voiceId: string;
  items: SpeechItem[];
}

export type StartedSpeechView = SpeechJobView & { charged?: { credits: number; balance: number } };

type SpeechJob = Job<SpeechJobData, SpeechJobResult>;

@Injectable()
export class SpeechService {
  constructor(
    @InjectQueue(QUEUE_SPEECH) private readonly queue: Queue<SpeechJobData, SpeechJobResult>,
    private readonly providers: ProviderCredentialsService,
    private readonly voices: VoicesService,
    private readonly pricing: PricingService,
    private readonly ledger: LedgerService,
    private readonly refunds: FeatureRefunds,
    @Inject(speechConfig.KEY) private readonly cfg: SpeechConfig,
  ) {}

  async start(user: AuthenticatedAppUser, request: StartSpeech, idempotencyKey: string): Promise<StartedSpeechView> {
    if (user.status === AccountStatus.suspended) {
      throw appError(HttpStatus.FORBIDDEN, ErrorCode.ACCOUNT_SUSPENDED, 'This account is suspended. Contact support.');
    }
    const { items, characters } = this.checkItems(request.items);

    const jobId = speechJobId(user.id, idempotencyKey);
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      // A resend of a request the server already has: the same job, no second
      // charge — even if its voice or the provider was switched off since; the
      // job carries what it needs, and the worker refunds it if it cannot run.
      if (!this.expired(existing)) return this.view(existing);
      throw keyReused();
    }

    const voice = await this.voices.voiceForJob(request.voiceId);
    if (!voice) {
      throw appError(HttpStatus.NOT_FOUND, ErrorCode.VOICE_NOT_FOUND, 'This voice is not available. Choose another.');
    }
    if (!(await this.providers.getActiveTextToSpeech())) {
      throw appError(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.TTS_UNAVAILABLE,
        'Text to speech is not available right now. Try again later.',
      );
    }

    const { credits, rule } = await this.pricing.price(CreditFeature.text_to_speech, characters);

    let charged: { credits: number; balance: number } | undefined;
    if (credits > 0) {
      // Held before any provider call; the worker refunds it if the job fails.
      const { transaction, replayed } = await this.ledger.post({
        userId: user.id,
        type: CreditTxType.feature_charge,
        amount: -credits,
        reference: jobId,
        requireActive: true,
        metadata: {
          feature: CreditFeature.text_to_speech,
          characters,
          texts: items.length,
          voiceId: voice.id,
          pricingRuleId: rule.id,
          pricingVersion: rule.version,
        },
      });
      // This key already paid for a job the queue no longer has (finished and
      // swept, or refunded). Running a new request on that old charge would make it free.
      if (replayed) throw keyReused();
      charged = { credits, balance: transaction.balanceAfter };
    }

    const keepSeconds = this.cfg.keepMinutes * 60;
    try {
      await this.queue.add(
        'synthesize',
        { userId: user.id, voiceId: voice.id, providerVoiceId: voice.providerVoiceId, items, credits },
        {
          jobId,
          // The retry is for outages only; the worker makes refusals unrecoverable.
          attempts: 2,
          backoff: { type: 'fixed', delay: 2_000 },
          removeOnComplete: { age: keepSeconds },
          removeOnFail: { age: keepSeconds },
        },
      );
    } catch (err) {
      await this.refunds.refund(user.id, jobId, credits, 'queue_failed');
      throw err;
    }

    return { jobId, status: 'queued', pollAfterMs: SPEECH_POLL_AFTER_MS, ...(charged ? { charged } : {}) };
  }

  async status(user: AuthenticatedAppUser, jobId: string): Promise<SpeechJobView> {
    return this.view(await this.ownJob(user, jobId));
  }

  /** The file of one finished voice, for the controller to stream. */
  async audioPath(user: AuthenticatedAppUser, jobId: string, itemId: string): Promise<string> {
    const job = await this.ownJob(user, jobId);
    const view = await this.view(job);
    if (view.status !== 'completed' || !ITEM_ID.test(itemId) || !view.items.some((item) => item.id === itemId)) {
      throw itemNotFound();
    }
    const path = itemPath(this.cfg.tmpDir, jobId, itemId);
    // Swept, or lost with the disk: the app makes the voice again.
    await access(path).catch(() => {
      throw itemNotFound();
    });
    return path;
  }

  /** The texts, trimmed, and how many characters they hold — or the reason they are refused. */
  private checkItems(items: SpeechItem[]): { items: SpeechItem[]; characters: number } {
    if (!Array.isArray(items) || items.length === 0) throw invalid('Send at least one text.');
    if (items.length > this.cfg.maxItems) throw invalid(`Send at most ${this.cfg.maxItems} texts at once.`);

    const ids = new Set<string>();
    const trimmed: SpeechItem[] = [];
    let characters = 0;
    for (const item of items) {
      const id = typeof item?.id === 'string' ? item.id : '';
      if (!ITEM_ID.test(id)) throw invalid('Each text needs an id of 1–64 letters, digits, "-" or "_".');
      if (ids.has(id)) throw invalid(`Two texts have the id "${id}".`);
      ids.add(id);

      const text = typeof item.text === 'string' ? item.text.trim() : '';
      if (!text) throw invalid(`The text "${id}" is empty.`);
      const count = countCharacters(text);
      if (count > this.cfg.maxItemCharacters) {
        throw tooLong(`The text "${id}" has ${count} characters; one text can have at most ${this.cfg.maxItemCharacters}.`, {
          itemId: id,
          characters: count,
          maxCharacters: this.cfg.maxItemCharacters,
        });
      }
      characters += count;
      trimmed.push({ id, text });
    }
    if (characters > this.cfg.maxRequestCharacters) {
      throw tooLong(
        `These texts have ${characters} characters; one request can have at most ${this.cfg.maxRequestCharacters}.`,
        { characters, maxCharacters: this.cfg.maxRequestCharacters },
      );
    }
    return { items: trimmed, characters };
  }

  private async ownJob(user: AuthenticatedAppUser, jobId: string): Promise<SpeechJob> {
    if (!SPEECH_JOB_ID.test(jobId)) throw jobNotFound();
    const job = await this.queue.getJob(jobId);
    if (!job || job.data.userId !== user.id) throw jobNotFound();
    // BullMQ prunes finished jobs by age only when a later job finishes, and the
    // sweeper only once a minute. The app is promised a fixed window, so enforce it here.
    if (this.expired(job)) throw jobNotFound();
    return job;
  }

  private expired(job: SpeechJob): boolean {
    return !!job.finishedOn && Date.now() - job.finishedOn > this.cfg.keepMinutes * 60_000;
  }

  private async view(job: SpeechJob): Promise<SpeechJobView> {
    const jobId = String(job.id);
    const state = await job.getState();
    switch (state) {
      case 'completed':
        return {
          jobId,
          status: 'completed',
          items: (job.returnvalue?.items ?? job.data.items).map(({ id }) => ({ id })),
        };
      case 'failed':
        return { jobId, status: 'failed', error: decodeFailure(job.failedReason) };
      case 'active':
        return { jobId, status: 'processing', pollAfterMs: SPEECH_POLL_AFTER_MS };
      case 'unknown':
        throw jobNotFound();
      default:
        return { jobId, status: 'queued', pollAfterMs: SPEECH_POLL_AFTER_MS };
    }
  }
}

function invalid(message: string) {
  return appError(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.VALIDATION_FAILED, message);
}

function tooLong(message: string, details: Record<string, unknown>) {
  return appError(HttpStatus.PAYLOAD_TOO_LARGE, ErrorCode.TEXT_TOO_LONG, message, details);
}

function keyReused() {
  return appError(
    HttpStatus.CONFLICT,
    ErrorCode.IDEMPOTENCY_KEY_REUSED,
    'This Idempotency-Key was already used for an earlier request. Send this request with a new key.',
  );
}

function jobNotFound(): NotFoundException {
  return new NotFoundException('No speech job with this id. Finished voices are deleted a while after they are ready.');
}

/** A voice the job does not hold, or held and has since deleted. */
export function itemNotFound(): NotFoundException {
  return new NotFoundException('No voice with this id in this job, or it was already deleted.');
}
