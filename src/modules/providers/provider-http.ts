import { ProviderKind } from '../../generated/prisma/enums';
import { ProviderError, providerMessage, scrub } from './provider-error';
import { PROVIDER_NAMES, type KeyCheck } from './speech-to-text.provider';

/** Long enough for a long video's audio; short enough that a hung socket frees its worker slot. */
export const TRANSCRIBE_TIMEOUT_MS = 10 * 60_000;
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

/** Asks the provider whether a key is valid, without spending any credit. Never throws. */
export async function probeKey(
  provider: ProviderKind,
  url: string,
  headers: Record<string, string>,
  apiKey: string,
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

  if (res.ok) return { ok: true, message: 'Key works.' };

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
