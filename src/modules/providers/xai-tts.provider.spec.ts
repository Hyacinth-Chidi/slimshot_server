import { ProviderError } from './provider-error';
import { XaiTextToSpeechProvider } from './xai-tts.provider';

const KEY = 'xai-test-key-0123456789';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mp3(bytes: number[]): Response {
  return new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
}

// The documented shape (docs.x.ai › REST API reference › voice): GET /v1/tts/voices.
const VOICES = {
  voices: [
    { voice_id: 'carina', name: 'Carina', language: 'en' },
    { voice_id: 'eve', name: 'Eve', language: null },
  ],
};

describe('XaiTextToSpeechProvider', () => {
  const provider = new XaiTextToSpeechProvider();
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('sends the text, the voice, auto language and MP3 at 24 kHz / 128 kbps', async () => {
    fetchMock.mockResolvedValue(mp3([0xff, 0xfb, 0x90]));
    await provider.synthesize({ text: 'Hello there.', voiceId: 'eve' }, KEY);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.x.ai/v1/tts');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ authorization: `Bearer ${KEY}`, 'content-type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({
      text: 'Hello there.',
      voice_id: 'eve',
      language: 'auto',
      output_format: { codec: 'mp3', sample_rate: 24000, bit_rate: 128000 },
    });
  });

  it('returns the MP3 bytes', async () => {
    fetchMock.mockResolvedValue(mp3([0xff, 0xfb, 0x90, 0x44]));
    const audio = await provider.synthesize({ text: 'Hi.', voiceId: 'eve' }, KEY);
    expect([...audio]).toEqual([0xff, 0xfb, 0x90, 0x44]);
  });

  it('reads the audio out of a JSON answer too', async () => {
    fetchMock.mockResolvedValue(
      json(200, { audio: Buffer.from([1, 2, 3]).toString('base64'), content_type: 'audio/mpeg', duration: 0.1 }),
    );
    const audio = await provider.synthesize({ text: 'Hi.', voiceId: 'eve' }, KEY);
    expect([...audio]).toEqual([1, 2, 3]);
  });

  it('an empty answer is an outage, worth a retry', async () => {
    fetchMock.mockResolvedValue(mp3([]));
    const error = await provider.synthesize({ text: 'Hi.', voiceId: 'eve' }, KEY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).retryable).toBe(true);
  });

  it('a 4xx is a ProviderError with the key scrubbed', async () => {
    fetchMock.mockResolvedValue(json(400, { error: `Voice not allowed for key ${KEY}` }));
    const error = await provider.synthesize({ text: 'Hi.', voiceId: 'nope' }, KEY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(400);
    expect((error as ProviderError).retryable).toBe(false);
    expect((error as ProviderError).message).not.toContain(KEY);
  });

  it('lists voices', async () => {
    fetchMock.mockResolvedValue(json(200, VOICES));
    await expect(provider.listVoices(KEY)).resolves.toEqual([
      { providerVoiceId: 'carina', name: 'Carina' },
      { providerVoiceId: 'eve', name: 'Eve' },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.x.ai/v1/tts/voices');
    expect(init.headers).toEqual({ authorization: `Bearer ${KEY}` });
  });

  it('a blocked key fails its test without spending anything', async () => {
    fetchMock.mockResolvedValue(json(200, { api_key_blocked: true }));
    await expect(provider.testKey(KEY)).resolves.toMatchObject({ ok: false });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.x.ai/v1/api-key');
  });
});
