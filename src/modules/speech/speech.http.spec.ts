import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ExecutionContext, INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { configureHttp } from '../../app.setup';
import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { UserAuthGuard } from '../accounts/user-auth.guard';
import { SpeechController } from './speech.controller';
import { SpeechService } from './speech.service';

const JOB_ID = `tts_${'0'.repeat(32)}`;
const QUEUED = { jobId: JOB_ID, status: 'queued', pollAfterMs: 1500 };
const ACCESS = 'Bearer a.b.c';
const BODY = { voiceId: 'v1', items: [{ id: 'text_1', text: 'Hello there.' }] };

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

describe('app speech API over HTTP', () => {
  let app: INestApplication;
  let base: string;
  let dir: string;
  const speech = { start: jest.fn(), status: jest.fn(), audioPath: jest.fn() };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'speech-http-'));
    const moduleRef = await Test.createTestingModule({
      controllers: [SpeechController],
      providers: [{ provide: SpeechService, useValue: speech }],
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
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    speech.start.mockReset().mockResolvedValue(QUEUED);
    speech.status.mockReset().mockResolvedValue(QUEUED);
    speech.audioPath.mockReset();
  });

  function post(opts: { auth?: string | null; key?: string | null; body?: unknown } = {}) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.auth !== null) headers.authorization = opts.auth ?? ACCESS;
    if (opts.key !== null) headers['idempotency-key'] = opts.key ?? 'key-12345678';
    return fetch(`${base}/api/app/v1/speech`, { method: 'POST', headers, body: JSON.stringify(opts.body ?? BODY) });
  }

  async function errorOf(res: Response): Promise<{ code: string; message: string }> {
    const body = (await res.json()) as { success: boolean; error: { code: string; message: string } };
    expect(body.success).toBe(false);
    return body.error;
  }

  it('starts a speech job for the signed-in user: 202', async () => {
    const res = await post();
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ success: true, data: QUEUED });
    expect(speech.start).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), BODY, 'key-12345678');
  });

  it.each([null, 'short', 'has spaces in it'])('POST needs an Idempotency-Key: 422s %j', async (key) => {
    const res = await post({ key });
    expect(res.status).toBe(422);
    expect(speech.start).not.toHaveBeenCalled();
  });

  it.each([
    ['no texts', { voiceId: 'v1', items: [] }],
    ['no voice', { items: BODY.items }],
    ['a text without an id', { voiceId: 'v1', items: [{ text: 'Hi' }] }],
    ['a text with a field of its own', { voiceId: 'v1', items: [{ id: 'a', text: 'Hi', speed: 2 }] }],
  ])('422s a body with %s before the service is asked', async (_label, body) => {
    const res = await post({ body });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe('VALIDATION_FAILED');
    expect(speech.start).not.toHaveBeenCalled();
  });

  it('signed out is 401, for every route', async () => {
    const answers = await Promise.all([
      post({ auth: null }),
      fetch(`${base}/api/app/v1/speech/${JOB_ID}`),
      fetch(`${base}/api/app/v1/speech/${JOB_ID}/items/text_1`),
    ]);
    for (const res of answers) {
      expect(res.status).toBe(401);
      expect((await errorOf(res)).code).toBe('SIGN_IN_REQUIRED');
    }
    expect(speech.start).not.toHaveBeenCalled();
    expect(speech.audioPath).not.toHaveBeenCalled();
  });

  it('passes 402 INSUFFICIENT_CREDITS through with required and balance', async () => {
    speech.start.mockRejectedValue(
      appError(402, ErrorCode.INSUFFICIENT_CREDITS, 'Not enough credits.', { required: 6, balance: 2 }),
    );
    const res = await post();
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({
      error: { code: 'INSUFFICIENT_CREDITS', details: { required: 6, balance: 2 } },
    });
  });

  it('polls a job for the signed-in user', async () => {
    const res = await fetch(`${base}/api/app/v1/speech/${JOB_ID}`, { headers: { authorization: ACCESS } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: QUEUED });
    expect(speech.status).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), JOB_ID);
  });

  it('the audio is served as audio/mpeg', async () => {
    const file = join(dir, 'text_1.mp3');
    writeFileSync(file, Buffer.from([0xff, 0xfb, 0x90, 0x64, 1, 2, 3]));
    speech.audioPath.mockResolvedValue(file);

    const res = await fetch(`${base}/api/app/v1/speech/${JOB_ID}/items/text_1`, { headers: { authorization: ACCESS } });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect(res.headers.get('content-length')).toBe('7');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from([0xff, 0xfb, 0x90, 0x64, 1, 2, 3]));
    expect(speech.audioPath).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), JOB_ID, 'text_1');
  });

  it('a voice the service does not have is 404', async () => {
    speech.audioPath.mockRejectedValue(new NotFoundException('No voice with this id in this job.'));
    const res = await fetch(`${base}/api/app/v1/speech/${JOB_ID}/items/nope`, { headers: { authorization: ACCESS } });
    expect(res.status).toBe(404);
  });

  it('a voice deleted between the check and the read is 404, and names no path', async () => {
    speech.audioPath.mockResolvedValue(join(dir, 'swept.mp3'));
    const res = await fetch(`${base}/api/app/v1/speech/${JOB_ID}/items/swept`, { headers: { authorization: ACCESS } });
    expect(res.status).toBe(404);
    expect((await errorOf(res)).message).not.toContain(dir);
  });
});
