import { createHash } from 'node:crypto';

import { ErrorCode } from '../../core/errors/error-codes';
import type { CaptionResult } from '../providers/speech-to-text.provider';

export const QUEUE_CAPTIONS = 'captions';

/** How long the app should wait before polling again. */
export const POLL_AFTER_MS = 1_500;

/** The app sends a UUID; anything this shape is accepted. */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,64}$/;

export const CAPTION_JOB_ID = /^cap_[0-9a-f]{32}$/;

export interface CaptionJobData {
  deviceId: string;
  filePath: string;
  mimeType: string;
  language: string | null;
}

/**
 * Derived, not random: a resend with the same Idempotency-Key lands on the
 * job that already exists instead of paying the provider twice, and the id
 * is scoped to the device that created it. The prefix keeps the id from
 * ever being all digits, which BullMQ refuses as a custom id.
 */
export function captionJobId(deviceId: string, idempotencyKey: string): string {
  const digest = createHash('sha256').update(`${deviceId}:${idempotencyKey}`).digest('hex');
  return `cap_${digest.slice(0, 32)}`;
}

const FAILURE_CODES = [ErrorCode.PROVIDER_FAILED, ErrorCode.CAPTIONS_UNAVAILABLE] as const;
export type CaptionFailureCode = (typeof FAILURE_CODES)[number];

export interface CaptionFailure {
  code: CaptionFailureCode;
  message: string;
}

/** BullMQ keeps only an error's message, so the code travels inside it. */
export function encodeFailure(code: CaptionFailureCode, message: string): string {
  return `${code}: ${message}`;
}

export function decodeFailure(reason: string | undefined): CaptionFailure {
  for (const code of FAILURE_CODES) {
    const prefix = `${code}: `;
    if (reason?.startsWith(prefix)) return { code, message: reason.slice(prefix.length) };
  }
  // Anything else is an internal error message; it stays in the server log.
  return {
    code: ErrorCode.PROVIDER_FAILED,
    message: 'The caption provider could not process this audio.',
  };
}

export type CaptionJobView =
  | { jobId: string; status: 'queued' | 'processing'; pollAfterMs: number }
  | { jobId: string; status: 'completed'; result: CaptionResult }
  | { jobId: string; status: 'failed'; error: CaptionFailure };
