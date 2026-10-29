import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderError } from './provider-error';
import { XaiProvider } from './xai.provider';

const KEY = 'xai-test-key-0123456789';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// The documented response shape (docs.x.ai, Speech to Text): punctuation rides on the word.
const FIXTURE = {
  text: 'The balance is $167,983.15.',
  language: 'en',
  duration: 3.45,
  words: [
    { text: 'The', start: 0.24, end: 0.48, confidence: 0.98 },
    { text: 'balance', start: 0.48, end: 0.96, confidence: 0.91 },
    { text: 'is', start: 0.96, end: 1.12 },
    { text: '$167,983.15.', start: 1.12, end: 3.2, confidence: 0.87 },
  ],
};

describe('XaiProvider', () => {
  const provider = new XaiProvider({ xaiModel: 'grok-voice-transcribe-2.0' } as never);
  let dir: string;
  let audioPath: string;
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xai-'));
    audioPath = join(dir, 'clip.audio');
    writeFileSync(audioPath, Buffer.from('fake-audio'));
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('posts multipart to /v1/stt with a bearer key, the model, and the file last', async () => {
    fetchMock.mockResolvedValue(json(200, FIXTURE));
    await provider.transcribe({ filePath: audioPath, mimeType: 'audio/wav' }, KEY);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.x.ai/v1/stt');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ authorization: `Bearer ${KEY}` });

    const form = init.body as FormData;
    expect(form.get('model')).toBe('grok-voice-transcribe-2.0');
    expect(form.has('language')).toBe(false);
    // Formatting needs a language; without one xAI detects the language itself.
    expect(form.has('format')).toBe(false);
    const file = form.get('file') as File;
    expect(file.type).toBe('audio/wav');
    expect(await file.text()).toBe('fake-audio');
    // xAI requires the file after all the other fields.
    expect([...form.keys()].pop()).toBe('file');
  });

  it('passes a requested language and asks for written-out numbers with it', async () => {
    fetchMock.mockResolvedValue(json(200, FIXTURE));
    await provider.transcribe({ filePath: audioPath, mimeType: 'audio/wav', language: 'fr' }, KEY);

    const form = fetchMock.mock.calls[0][1]?.body as FormData;
    expect(form.get('language')).toBe('fr');
    expect(form.get('format')).toBe('true');
    expect([...form.keys()].pop()).toBe('file');
  });

  it('returns the words with their times, and full confidence where xAI gives none', async () => {
    fetchMock.mockResolvedValue(json(200, FIXTURE));
    const result = await provider.transcribe({ filePath: audioPath, mimeType: 'audio/wav' }, KEY);

    expect(result).toEqual({
      provider: 'xai',
      language: 'en',
      durationSeconds: 3.45,
      text: 'The balance is $167,983.15.',
      words: [
        { text: 'The', start: 0.24, end: 0.48, confidence: 0.98 },
        { text: 'balance', start: 0.48, end: 0.96, confidence: 0.91 },
        { text: 'is', start: 0.96, end: 1.12, confidence: 1 },
        { text: '$167,983.15.', start: 1.12, end: 3.2, confidence: 0.87 },
      ],
    });
  });

  it('keeps the language the app asked for over the detected one', async () => {
    fetchMock.mockResolvedValue(json(200, { ...FIXTURE, language: 'en-US' }));
    const result = await provider.transcribe({ filePath: audioPath, mimeType: 'audio/wav', language: 'en' }, KEY);
    expect(result.language).toBe('en');
  });

  it('falls back to the last word end when the duration is missing', async () => {
    fetchMock.mockResolvedValue(json(200, { ...FIXTURE, duration: undefined }));
    const result = await provider.transcribe({ filePath: audioPath, mimeType: 'audio/wav' }, KEY);
    expect(result.durationSeconds).toBe(3.2);
  });

  it('returns an empty caption for silence instead of failing', async () => {
    fetchMock.mockResolvedValue(json(200, { text: '', language: 'en', words: [] }));
    const result = await provider.transcribe({ filePath: audioPath, mimeType: 'audio/wav' }, KEY);
    expect(result).toMatchObject({ text: '', words: [], durationSeconds: null });
  });

  it.each([
    [400, { code: 'Client specified an invalid argument', error: 'Incorrect API key provided: xa***89.' }, 'Incorrect API key provided: xa***89.'],
    [429, { code: 'Too many requests', error: 'Rate limit exceeded' }, 'Rate limit exceeded'],
  ])("maps HTTP %i to a ProviderError with xAI's message", async (status, body, message) => {
    fetchMock.mockResolvedValue(json(status, body));
    const error = await provider
      .transcribe({ filePath: audioPath, mimeType: 'audio/wav' }, KEY)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(status);
    expect((error as ProviderError).message).toBe(message);
  });

  it('never lets the key through in an error message', async () => {
    fetchMock.mockResolvedValue(json(400, { error: `Incorrect API key provided: ${KEY}` }));
    const error = (await provider
      .transcribe({ filePath: audioPath, mimeType: 'audio/wav' }, KEY)
      .catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain(KEY);
  });

  describe('testKey', () => {
    it('asks xAI about the key, spending nothing', async () => {
      fetchMock.mockResolvedValue(
        json(200, { name: 'slimshot', api_key_blocked: false, api_key_disabled: false, team_blocked: false }),
      );
      await expect(provider.testKey(KEY)).resolves.toEqual({ ok: true, message: 'Key works.' });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.x.ai/v1/api-key');
      expect(init.headers).toEqual({ authorization: `Bearer ${KEY}` });
    });

    it.each([
      [{ api_key_blocked: true }, 'xAI has blocked this key.'],
      [{ api_key_disabled: true }, 'This key is disabled in the xAI console.'],
      [{ team_blocked: true }, 'xAI has blocked the team that owns this key.'],
    ])('reports a key xAI answers for but will not serve (%j)', async (flags, message) => {
      fetchMock.mockResolvedValue(
        json(200, { api_key_blocked: false, api_key_disabled: false, team_blocked: false, ...flags }),
      );
      await expect(provider.testKey(KEY)).resolves.toEqual({ ok: false, message });
    });

    it('reports a rejected key', async () => {
      fetchMock.mockResolvedValue(
        json(400, { code: 'Client specified an invalid argument', error: 'Incorrect API key provided' }),
      );
      await expect(provider.testKey(KEY)).resolves.toEqual({
        ok: false,
        message: 'xAI returned an error: Incorrect API key provided',
      });
    });

    it('reports an unreachable xAI without throwing', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      await expect(provider.testKey(KEY)).resolves.toMatchObject({ ok: false });
    });
  });
});
