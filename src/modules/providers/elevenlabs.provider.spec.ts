import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ElevenLabsProvider } from './elevenlabs.provider';
import { ProviderError } from './provider-error';

const KEY = 'el-test-key-0123456789';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const FIXTURE = {
  language_code: 'eng',
  language_probability: 0.98,
  text: 'Hello (laughs) world!',
  audio_duration_secs: 1.5,
  words: [
    { text: 'Hello', type: 'word', start: 0, end: 0.5, logprob: -0.1 },
    { text: ' ', type: 'spacing', start: 0.5, end: 0.5, logprob: 0 },
    { text: '(laughs)', type: 'audio_event', start: 0.5, end: 0.8, logprob: 0 },
    { text: 'world!', type: 'word', start: 0.8, end: 1.2, logprob: 0 },
  ],
};

describe('ElevenLabsProvider', () => {
  const provider = new ElevenLabsProvider({ elevenlabsModel: 'scribe_v2' } as never);
  let dir: string;
  let audioPath: string;
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'el-'));
    audioPath = join(dir, 'clip.audio');
    writeFileSync(audioPath, Buffer.from('fake-audio'));
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('posts multipart with the model, word timestamps and no audio events', async () => {
    fetchMock.mockResolvedValue(json(200, FIXTURE));
    await provider.transcribe({ filePath: audioPath, mimeType: 'audio/mp4' }, KEY);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'xi-api-key': KEY });

    const form = init.body as FormData;
    expect(form.get('model_id')).toBe('scribe_v2');
    expect(form.get('timestamps_granularity')).toBe('word');
    expect(form.get('tag_audio_events')).toBe('false');
    expect(form.has('language_code')).toBe(false);
    const file = form.get('file') as File;
    expect(file.type).toBe('audio/mp4');
    expect(await file.text()).toBe('fake-audio');
  });

  it('passes a requested language', async () => {
    fetchMock.mockResolvedValue(json(200, FIXTURE));
    await provider.transcribe({ filePath: audioPath, mimeType: 'audio/mp4', language: 'yo' }, KEY);
    expect((fetchMock.mock.calls[0][1]?.body as FormData).get('language_code')).toBe('yo');
  });

  it('keeps spoken words only and turns log-probability into 0–1 confidence', async () => {
    fetchMock.mockResolvedValue(json(200, FIXTURE));
    const result = await provider.transcribe({ filePath: audioPath, mimeType: 'audio/mp4' }, KEY);

    expect(result).toEqual({
      provider: 'elevenlabs',
      language: 'eng',
      durationSeconds: 1.5,
      text: 'Hello (laughs) world!',
      words: [
        { text: 'Hello', start: 0, end: 0.5, confidence: 0.905 },
        { text: 'world!', start: 0.8, end: 1.2, confidence: 1 },
      ],
    });
  });

  it('falls back to the last word end when the duration is missing', async () => {
    // undefined drops out of JSON.stringify, so the field is simply absent.
    fetchMock.mockResolvedValue(json(200, { ...FIXTURE, audio_duration_secs: undefined }));
    const result = await provider.transcribe({ filePath: audioPath, mimeType: 'audio/mp4' }, KEY);
    expect(result.durationSeconds).toBe(1.2);
  });

  it('returns an empty caption for silence instead of failing', async () => {
    fetchMock.mockResolvedValue(json(200, { language_code: 'eng', text: '', words: [] }));
    const result = await provider.transcribe({ filePath: audioPath, mimeType: 'audio/mp4' }, KEY);
    expect(result).toMatchObject({ text: '', words: [], durationSeconds: null });
  });

  it.each([
    [401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } }, 'Invalid API key'],
    [422, { detail: [{ loc: ['body', 'file'], msg: 'field required' }] }, 'field required'],
  ])('maps HTTP %i to a ProviderError with the provider message', async (status, body, message) => {
    fetchMock.mockResolvedValue(json(status, body));
    const error = await provider
      .transcribe({ filePath: audioPath, mimeType: 'audio/mp4' }, KEY)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(status);
    expect((error as ProviderError).message).toBe(message);
  });

  describe('testKey', () => {
    it('probes the user endpoint with the key', async () => {
      fetchMock.mockResolvedValue(json(200, { subscription: {} }));
      await expect(provider.testKey(KEY)).resolves.toEqual({ ok: true, message: 'Key works.' });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.elevenlabs.io/v1/user');
      expect(init.headers).toEqual({ 'xi-api-key': KEY });
    });

    it('treats 403 as a valid key without the user scope', async () => {
      fetchMock.mockResolvedValue(json(403, { detail: { message: 'missing_permissions' } }));
      await expect(provider.testKey(KEY)).resolves.toMatchObject({ ok: true });
    });

    it('reports a rejected key', async () => {
      fetchMock.mockResolvedValue(json(401, { detail: { message: 'Invalid API key' } }));
      await expect(provider.testKey(KEY)).resolves.toEqual({
        ok: false,
        message: 'ElevenLabs rejected this key: Invalid API key',
      });
    });
  });
});
