import { ProviderKind } from '../../generated/prisma/enums';

/** A provider answered with a non-2xx status. */
export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderKind,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  /** Worth one more try: the provider was down or throttling, not refusing the request itself. */
  get retryable(): boolean {
    return this.status >= 500 || this.status === 429;
  }
}

/** Pulls a human message out of the error bodies Deepgram and ElevenLabs send. */
export function providerMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const b = body as Record<string, unknown>;

  if (typeof b.err_msg === 'string') return b.err_msg; // Deepgram
  if (typeof b.message === 'string') return b.message;

  const detail = b.detail; // ElevenLabs
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    const first = detail[0] as { msg?: unknown } | undefined;
    if (typeof first?.msg === 'string') return first.msg;
  } else if (detail && typeof detail === 'object') {
    const message = (detail as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }

  return fallback;
}

/** Providers sometimes echo the credential back; it must never reach a log, a job result or the dashboard. */
export function scrub(text: string, secret: string): string {
  return secret ? text.split(secret).join('[redacted]') : text;
}
