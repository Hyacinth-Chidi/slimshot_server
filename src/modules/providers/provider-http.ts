import { ProviderKind } from '../../generated/prisma/enums';
import { ProviderError, providerMessage, scrub } from './provider-error';
import { PROVIDER_NAMES, type KeyCheck } from './speech-to-text.provider';

/** Long enough for a long video's audio; short enough that a hung socket frees its worker slot. */
export const TRANSCRIBE_TIMEOUT_MS = 10 * 60_000;
/** One text's voice: seconds of work, so a hung request frees its worker slot well before the app gives up. */
export const SYNTHESIZE_TIMEOUT_MS = 2 * 60_000;
const KEY_CHECK_TIMEOUT_MS = 15_000;

/**
 * Sends a request and parses the JSON answer. A non-2xx becomes a
 * ProviderError carrying the provider's own message with the key scrubbed
 * out. Network failures and timeouts are rethrown untouched: the worker
 * treats them as worth a retry.
 */
export async function requestJson<T>(
  provider: ProviderKind,
  url: string,
  init: RequestInit,
  apiKey: string,
  timeoutMs = TRANSCRIBE_TIMEOUT_MS,
): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const body: unknown = await res.json().catch(() => null);
  const name = PROVIDER_NAMES[provider];

  if (!res.ok) {
    const message = providerMessage(body, `${name} returned HTTP ${res.status}.`);
    throw new ProviderError(provider, res.status, scrub(message, apiKey));
  }
  if (body === null) {
    // Reported as a 502 so the worker retries it like any other outage.
    throw new ProviderError(provider, 502, `${name} returned an unreadable response.`);
  }
  return body as T;
}

/**
 * Sends a request and answers the audio it returns: the body's bytes, or the
 * base64 `audio` of a JSON answer (xAI sends JSON when timestamps are asked
 * for, and its examples read raw bytes otherwise). A non-2xx is a
 * ProviderError as in `requestJson`; an answer without audio is reported as a
 * 502 so the worker retries it like any other outage.
 */
export async function requestAudio(
  provider: ProviderKind,
  url: string,
  init: RequestInit,
  apiKey: string,
  timeoutMs = SYNTHESIZE_TIMEOUT_MS,
): Promise<Buffer> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const name = PROVIDER_NAMES[provider];

  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const message = providerMessage(body, `${name} returned HTTP ${res.status}.`);
    throw new ProviderError(provider, res.status, scrub(message, apiKey));
  }

  let audio: Buffer;
  if ((res.headers.get('content-type') ?? '').includes('application/json')) {
    const body = (await res.json().catch(() => null)) as { audio?: unknown } | null;
    audio = typeof body?.audio === 'string' ? Buffer.from(body.audio, 'base64') : Buffer.alloc(0);
  } else {
    audio = Buffer.from(await res.arrayBuffer());
  }
  if (audio.length === 0) throw new ProviderError(provider, 502, `${name} returned no audio.`);
  return audio;
}

/**
 * Asks the provider whether a key is valid, without spending any credit. Never throws.
 * `inspect` reads a 2xx answer for providers that report a refused key inside one
 * (xAI answers 200 for a blocked key); null means the answer is fine.
 */
export async function probeKey(
  provider: ProviderKind,
  url: string,
  headers: Record<string, string>,
  apiKey: string,
  inspect?: (body: unknown) => KeyCheck | null,
): Promise<KeyCheck> {
  const name = PROVIDER_NAMES[provider];
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(KEY_CHECK_TIMEOUT_MS) });
  } catch {
    return {
      ok: false,
      message: `Could not reach ${name}. Check the server's internet connection and try again.`,
    };
  }

  if (res.ok) {
    const verdict = inspect?.(await res.json().catch(() => null));
    return verdict ?? { ok: true, message: 'Key works.' };
  }

  // 403: the key authenticated but lacks the scope this probe endpoint needs.
  // Transcription uses a different scope, so the key is still usable.
  if (res.status === 403) {
    return {
      ok: true,
      message: 'Key works. (It cannot read account details, which Auto caption does not need.)',
    };
  }

  const body: unknown = await res.json().catch(() => null);
  const detail = scrub(providerMessage(body, `HTTP ${res.status}`), apiKey);
  if (res.status === 401) return { ok: false, message: `${name} rejected this key: ${detail}` };
  return { ok: false, message: `${name} returned an error: ${detail}` };
}
