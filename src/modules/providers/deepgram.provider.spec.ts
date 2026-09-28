import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeepgramProvider } from './deepgram.provider';
import { ProviderError } from './provider-error';

const KEY = 'dg-test-key-0123456789';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const FIXTURE = {
  metadata: { duration: 2.5 },
  results: {
    channels: [
      {
        detected_language: 'en',
        alternatives: [
          {
            transcript: 'Hello world.',
            words: [
              { word: 'hello', punctuated_word: 'Hello', start: 0.08, end: 0.4, confidence: 0.99 },
              { word: 'world', punctuated_word: 'world.', start: 0.4, end: 0.9, confidence: 0.97 },
            ],
          },
        ],
      },
    ],
  },
};

describe('DeepgramProvider', () => {
  const provider = new DeepgramProvider({ deepgramModel: 'nova-3' } as never);
  let dir: string;
  let audioPath: string;
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dg-'));
    audioPath = join(dir, 'clip.audio');
    writeFileSync(audioPath, Buffer.from('fake-audio'));
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('posts the raw audio with the model, formatting and language detection', async () => {
    fetchMock.mockResolvedValue(json(200, FIXTURE));
    await provider.transcribe({ filePath: audioPath, mimeType: 'audio/mp4' }, KEY);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe('https://api.deepgram.com/v1/listen');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      model: 'nova-3',
      smart_format: 'true',
      punctuate: 'true',
      detect_language: 'true',
    });
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ authorization: `Token ${KEY}`, 'content-type': 'audio/mp4' });
    expect(Buffer.from(init.body as Uint8Array).toString()).toBe('fake-audio');
  });

  it('sends the requested language instead of detecting one', async () => {
    fetchMock.mockResolvedValue(json(200, FIXTURE));
    await provider.transcribe({ filePath: audioPath, mimeType: 'audio/mp4', language: 'fr' }, KEY);

    const u = new URL(fetchMock.mock.calls[0][0] as string);
    expect(u.searchParams.get('language')).toBe('fr');
    expect(u.searchParams.has('detect_language')).toBe(false);
  });

  it('normalizes words: punctuated text, seconds, confidence', async () => {
    fetchMock.mockResolvedValue(json(200, FIXTURE));
    const result = await provider.transcribe({ filePath: audioPath, mimeType: 'audio/mp4' }, KEY);

    expect(result).toEqual({
      provider: 'deepgram',
      language: 'en',
      durationSeconds: 2.5,
      text: 'Hello world.',
      words: [
        { text: 'Hello', start: 0.08, end: 0.4, confidence: 0.99 },
        { text: 'world.', start: 0.4, end: 0.9, confidence: 0.97 },
      ],
    });
  });

  it('reports the requested language rather than a detected one', async () => {
    fetchMock.mockResolvedValue(json(200, FIXTURE));
    const result = await provider.transcribe(
      { filePath: audioPath, mimeType: 'audio/mp4', language: 'yo' },
      KEY,
    );
    expect(result.language).toBe('yo');
  });

  it('returns an empty caption for silence instead of failing', async () => {
    fetchMock.mockResolvedValue(json(200, { metadata: { duration: 3 }, results: { channels: [{ alternatives: [] }] } }));
    const result = await provider.transcribe({ filePath: audioPath, mimeType: 'audio/mp4' }, KEY);

    expect(result).toMatchObject({ text: '', words: [], durationSeconds: 3 });
  });

  it('maps a refusal to a non-retryable ProviderError with the provider message and no key', async () => {
    fetchMock.mockResolvedValue(json(400, { err_code: 'Bad Request', err_msg: `Corrupt audio (key ${KEY})` }));

    const error = await provider
      .transcribe({ filePath: audioPath, mimeType: 'audio/mp4' }, KEY)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(400);
    expect((error as ProviderError).retryable).toBe(false);
    expect((error as ProviderError).message).toBe('Corrupt audio (key [redacted])');
  });

  it('marks an outage as retryable', async () => {
    fetchMock.mockResolvedValue(json(503, { err_msg: 'Service unavailable' }));
    const error = await provider
      .transcribe({ filePath: audioPath, mimeType: 'audio/mp4' }, KEY)
      .catch((e: unknown) => e);
    expect((error as ProviderError).retryable).toBe(true);
  });

  describe('testKey', () => {
    it('probes the projects endpoint with the key', async () => {
      fetchMock.mockResolvedValue(json(200, { projects: [] }));
      await expect(provider.testKey(KEY)).resolves.toEqual({ ok: true, message: 'Key works.' });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.deepgram.com/v1/projects');
      expect(init.headers).toEqual({ authorization: `Token ${KEY}` });
    });

    it('reports a rejected key with the provider message', async () => {
      fetchMock.mockResolvedValue(json(401, { err_msg: 'Invalid credentials.' }));
      const check = await provider.testKey(KEY);
      expect(check.ok).toBe(false);
      expect(check.message).toBe('Deepgram rejected this key: Invalid credentials.');
    });

    it('reports an unreachable provider without throwing', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      const check = await provider.testKey(KEY);
      expect(check.ok).toBe(false);
      expect(check.message).toMatch(/Could not reach Deepgram/);
    });
  });
});
