import { INestApplication, ServiceUnavailableException } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';

import { configureHttp } from '../../app.setup';
import { ErrorCode } from '../../core/errors/error-codes';
import { DeviceAuthGuard } from '../devices/device-auth.guard';
import { DevicesController } from '../devices/devices.controller';
import { DevicesService } from '../devices/devices.service';
import { CaptionsController } from './captions.controller';
import { CaptionsService } from './captions.service';

const LIMIT = 1_024;
const QUEUED = { jobId: 'cap_0123456789abcdef0123456789abcdef', status: 'queued', pollAfterMs: 1500 };

describe('app caption API over HTTP', () => {
  let app: INestApplication;
  let base: string;
  const captions = { start: jest.fn(), status: jest.fn() };
  const devices = {
    register: jest.fn(async () => ({ deviceId: 'dev-1', token: 'tok' })),
    authenticate: jest.fn(async (t: string) => (t === 'good-token' ? { id: 'dev-1' } : null)),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MulterModule.register({ limits: { fileSize: LIMIT, files: 1 } })],
      controllers: [CaptionsController, DevicesController],
      providers: [
        { provide: CaptionsService, useValue: captions },
        { provide: DevicesService, useValue: devices },
        DeviceAuthGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    configureHttp(app);
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    captions.start.mockReset().mockResolvedValue(QUEUED);
    captions.status.mockReset().mockResolvedValue(QUEUED);
  });

  function upload(opts: {
    token?: string | null;
    key?: string | null;
    bytes?: number;
    type?: string;
    language?: string;
    withAudio?: boolean;
  } = {}) {
    const form = new FormData();
    if (opts.withAudio !== false) {
      form.append(
        'audio',
        new Blob([new Uint8Array(opts.bytes ?? 16)], { type: opts.type ?? 'audio/mp4' }),
        'clip.m4a',
      );
    }
    if (opts.language !== undefined) form.append('language', opts.language);

    const headers: Record<string, string> = {};
    if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? 'good-token'}`;
    if (opts.key !== null) headers['idempotency-key'] = opts.key ?? 'key-12345678';

    return fetch(`${base}/api/app/v1/captions`, { method: 'POST', headers, body: form });
  }

  async function errorOf(res: Response): Promise<{ code: string; message: string }> {
    const body = (await res.json()) as { success: boolean; error: { code: string; message: string } };
    expect(body.success).toBe(false);
    return body.error;
  }

  it('registers a device', async () => {
    const res = await fetch(`${base}/api/app/v1/devices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'android', appVersion: '1.4.0' }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ success: true, data: { deviceId: 'dev-1', token: 'tok' } });
  });

  it('registers a device with no body at all', async () => {
    const res = await fetch(`${base}/api/app/v1/devices`, { method: 'POST' });
    expect(res.status).toBe(201);
  });

  it('rejects an unknown platform', async () => {
    const res = await fetch(`${base}/api/app/v1/devices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'symbian' }),
    });
    expect(res.status).toBe(422);
  });

  it('starts a caption job: 202 with the job', async () => {
    const res = await upload({ language: 'EN' });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ success: true, data: QUEUED });
    const [device, audio, language, key] = captions.start.mock.calls[0] as [
      unknown,
      { buffer: Buffer; mimetype: string },
      string,
      string,
    ];
    expect(device).toEqual({ id: 'dev-1' });
    expect(audio.mimetype).toBe('audio/mp4');
    expect(audio.buffer).toHaveLength(16);
    expect(language).toBe('en');
    expect(key).toBe('key-12345678');
  });

  it('401s without a device token, before reading the upload', async () => {
    const res = await upload({ token: null });
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe(ErrorCode.UNAUTHENTICATED);
    expect(captions.start).not.toHaveBeenCalled();
  });

  it('401s an unknown device token', async () => {
    const res = await upload({ token: 'stolen' });
    expect(res.status).toBe(401);
  });

  it.each([null, 'short', 'has spaces in it', 'x'.repeat(65)])('422s Idempotency-Key %j', async (key) => {
    const res = await upload({ key });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('422s a request with no audio', async () => {
    const res = await upload({ withAudio: false });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).message).toMatch(/"audio"/);
  });

  it('415s audio sent as application/octet-stream, naming what it received', async () => {
    const res = await upload({ type: 'application/octet-stream' });
    expect(res.status).toBe(415);
    const error = await errorOf(res);
    expect(error.code).toBe(ErrorCode.UNSUPPORTED_MEDIA);
    expect(error.message).toContain('application/octet-stream');
  });

  it('413s audio over the size limit', async () => {
    const res = await upload({ bytes: LIMIT * 2 });
    expect(res.status).toBe(413);
    expect((await errorOf(res)).code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
  });

  it('422s a language that is not a two-letter code', async () => {
    const res = await upload({ language: 'english' });
    expect(res.status).toBe(422);
  });

  it('503s with CAPTIONS_UNAVAILABLE when no provider is active', async () => {
    captions.start.mockRejectedValue(
      new ServiceUnavailableException({ code: ErrorCode.CAPTIONS_UNAVAILABLE, message: 'off' }),
    );
    const res = await upload();
    expect(res.status).toBe(503);
    expect((await errorOf(res)).code).toBe(ErrorCode.CAPTIONS_UNAVAILABLE);
  });

  it('polls a job for the calling device', async () => {
    const res = await fetch(`${base}/api/app/v1/captions/${QUEUED.jobId}`, {
      headers: { authorization: 'Bearer good-token' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: QUEUED });
    expect(captions.status).toHaveBeenCalledWith({ id: 'dev-1' }, QUEUED.jobId);
  });

  it('401s a poll without a token', async () => {
    const res = await fetch(`${base}/api/app/v1/captions/${QUEUED.jobId}`);
    expect(res.status).toBe(401);
  });
});
