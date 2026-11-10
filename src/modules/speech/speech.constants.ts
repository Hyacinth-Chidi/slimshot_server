import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { ErrorCode } from '../../core/errors/error-codes';

export const QUEUE_SPEECH = 'speech';

/** How long the app should wait before polling again. */
export const SPEECH_POLL_AFTER_MS = 1_500;

export const SPEECH_JOB_ID = /^tts_[0-9a-f]{32}$/;

/** An item's id: the app's text id. Also its file's name, so nothing else gets through. */
export const ITEM_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface SpeechItem {
  id: string;
  /** Trimmed. */
  text: string;
}

export interface SpeechJobData {
  userId: string;
  voiceId: string;
  /** The provider's id for the voice, taken when the job was accepted. */
  providerVoiceId: string;
  items: SpeechItem[];
  /** What this job was charged; refunded if it fails. */
  credits: number;
}

export interface SpeechJobResult {
  items: { id: string }[];
}

/**
 * Derived, not random: a resend with the same Idempotency-Key lands on the job
 * that already exists instead of charging twice, scoped to its user. The
 * prefix keeps the id from ever being all digits, which BullMQ refuses.
 */
export function speechJobId(userId: string, idempotencyKey: string): string {
  const digest = createHash('sha256').update(`${userId}:${idempotencyKey}`).digest('hex');
  return `tts_${digest.slice(0, 32)}`;
}

/** Where a job's voices are written, one MP3 per item. */
export function jobDir(tmpDir: string, jobId: string): string {
  return join(tmpDir, jobId);
}

export function itemPath(tmpDir: string, jobId: string, itemId: string): string {
  return join(tmpDir, jobId, `${itemId}.mp3`);
}

const FAILURE_CODES = [ErrorCode.PROVIDER_FAILED, ErrorCode.TTS_UNAVAILABLE] as const;
export type SpeechFailureCode = (typeof FAILURE_CODES)[number];

export interface SpeechFailure {
  code: SpeechFailureCode;
  message: string;
}

/** BullMQ keeps only an error's message, so the code travels inside it. */
export function encodeFailure(code: SpeechFailureCode, message: string): string {
  return `${code}: ${message}`;
}

export function decodeFailure(reason: string | undefined): SpeechFailure {
  for (const code of FAILURE_CODES) {
    const prefix = `${code}: `;
    if (reason?.startsWith(prefix)) return { code, message: reason.slice(prefix.length) };
  }
  // Anything else is an internal error message; it stays in the server log.
  return { code: ErrorCode.PROVIDER_FAILED, message: 'The voice could not be made.' };
}

export type SpeechJobView =
  | { jobId: string; status: 'queued' | 'processing'; pollAfterMs: number }
  | { jobId: string; status: 'completed'; items: { id: string }[] }
  | { jobId: string; status: 'failed'; error: SpeechFailure };
