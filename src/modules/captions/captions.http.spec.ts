import { ExecutionContext, INestApplication } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';

import { configureHttp } from '../../app.setup';
import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { UserAuthGuard } from '../accounts/user-auth.guard';
import { DevicesController } from '../devices/devices.controller';
import { DevicesService } from '../devices/devices.service';
import { CaptionsController } from './captions.controller';
import { CaptionsService } from './captions.service';

const LIMIT = 1_024;
const QUEUED = { jobId: 'cap_0123456789abcdef0123456789abcdef', status: 'queued', pollAfterMs: 1500 };
const ACCESS = 'Bearer a.b.c';

// Stands in for UserAuthGuard: the real one is covered by its own spec.
const fakeGuard = {
  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string>; appUser?: unknown }>();
    if (req.headers.authorization !== ACCESS) {
      throw appError(401, ErrorCode.SIGN_IN_REQUIRED, 'Sign in to use this feature.');
    }
    req.appUser = { id: 'u1', sessionId: 's1', deviceId: 'dev-1', status: 'active' };
    return true;
  },
};

describe('app caption API over HTTP', () => {
  let app: INestApplication;
  let base: string;
  const captions = { start: jest.fn(), status: jest.fn() };
  const devices = { register: jest.fn(async () => ({ deviceId: 'dev-1', token: 'tok' })) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MulterModule.register({ limits: { fileSize: LIMIT, files: 1 } })],
      controllers: [CaptionsController, DevicesController],
      providers: [
        { provide: CaptionsService, useValue: captions },
        { provide: DevicesService, useValue: devices },
      ],
    })
      .overrideGuard(UserAuthGuard)
      .useValue(fakeGuard)
      .compile();

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

  function upload(
    opts: { auth?: string | null; key?: string | null; bytes?: number; language?: string; withAudio?: boolean } = {},
  ) {
    const form = new FormData();
    if (opts.withAudio !== false) {
      form.append('audio', new Blob([new Uint8Array(opts.bytes ?? 16)], { type: 'audio/wav' }), 'clip.wav');
    }
    if (opts.language !== undefined) form.append('language', opts.language);
    const headers: Record<string, string> = {};
    if (opts.auth !== null) headers.authorization = opts.auth ?? ACCESS;
    if (opts.key !== null) headers['idempotency-key'] = opts.key ?? 'key-12345678';
    return fetch(`${base}/api/app/v1/captions`, { method: 'POST', headers, body: form });
  }

  async function errorOf(res: Response): Promise<{ code: string; message: string }> {
    const body = (await res.json()) as { success: boolean; error: { code: string; message: string } };
    expect(body.success).toBe(false);
    return body.error;
  }

  it('registers a device without signing in', async () => {
    const res = await fetch(`${base}/api/app/v1/devices`, { method: 'POST' });
    expect(res.status).toBe(201);
  });

  it('starts a caption job for the signed-in user: 202', async () => {
    const res = await upload({ language: 'EN' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ success: true, data: QUEUED });
    const [appUser, audio, language, key] = captions.start.mock.calls[0] as [
      unknown,
      { mimetype: string },
      string,
      string,
    ];
    expect(appUser).toMatchObject({ id: 'u1' });
    expect(audio.mimetype).toBe('audio/wav');
    expect(language).toBe('en');
    expect(key).toBe('key-12345678');
  });

  it.each([null, 'Bearer device-token-not-a-jwt'])(
    '401 SIGN_IN_REQUIRED without a signed-in user (%p)',
    async (auth) => {
      const res = await upload({ auth });
      expect(res.status).toBe(401);
      expect((await errorOf(res)).code).toBe('SIGN_IN_REQUIRED');
      expect(captions.start).not.toHaveBeenCalled();
    },
  );

  it.each([null, 'short', 'has spaces in it'])('422s Idempotency-Key %j', async (key) => {
    const res = await upload({ key });
    expect(res.status).toBe(422);
  });

  it('422s a request with no audio', async () => {
    const res = await upload({ withAudio: false });
    expect(res.status).toBe(422);
  });

  it('413s audio over the size limit', async () => {
    const res = await upload({ bytes: LIMIT * 2 });
    expect(res.status).toBe(413);
    expect((await errorOf(res)).code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('passes 402 INSUFFICIENT_CREDITS through with required and balance', async () => {
    captions.start.mockRejectedValue(
      appError(402, ErrorCode.INSUFFICIENT_CREDITS, 'Not enough credits.', { required: 6, balance: 2 }),
    );
    const res = await upload();
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({
      error: { code: 'INSUFFICIENT_CREDITS', details: { required: 6, balance: 2 } },
    });
  });

  it('polls a job for the signed-in user', async () => {
    const res = await fetch(`${base}/api/app/v1/captions/${QUEUED.jobId}`, { headers: { authorization: ACCESS } });
    expect(res.status).toBe(200);
    expect(captions.status).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), QUEUED.jobId);
  });
});
