import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HttpException, NotFoundException } from '@nestjs/common';

import { makeWav } from '../../../test/fakes/wav';
import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { captionJobId } from './captions.constants';
import { CaptionsService } from './captions.service';

const posixIt = process.platform === 'win32' ? it.skip : it;
const user = (status = 'active') => ({ id: 'u1', sessionId: 's1', deviceId: 'dev-1', status }) as never;
const KEY = 'key-12345678';
const RESULT = { provider: 'deepgram', language: 'en', durationSeconds: 1, text: 'Hi.', words: [] };

interface FakeJob {
  id: string;
  data: { userId: string; filePath: string };
  state: string;
  returnvalue?: unknown;
  failedReason?: string;
  finishedOn?: number;
  getState: () => Promise<string>;
}

function build({ active = true, ttl = 180, credits = 6 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'captions-'));
  const jobs = new Map<string, FakeJob>();
  const queue = {
    getJob: jest.fn(async (id: string) => jobs.get(id)),
    add: jest.fn(async (_name: string, data: FakeJob['data'], opts: { jobId: string }) => {
      const job: FakeJob = { id: opts.jobId, data, state: 'waiting', getState: async () => job.state };
      jobs.set(opts.jobId, job);
      return job;
    }),
  };
  const providers = { getActive: jest.fn(async () => (active ? { adapter: {}, apiKey: 'k' } : null)) };
  const pricing = { price: jest.fn(async () => ({ credits, rule: { id: 'r1', version: 3 } })) };
  const ledger = { post: jest.fn(async () => ({ transaction: { balanceAfter: 88 }, replayed: false })) };
  const refunds = { refund: jest.fn(async () => undefined) };
  const cfg = { tmpDir: join(dir, 'audio'), resultTtlSeconds: ttl };
  const svc = new CaptionsService(
    queue as never,
    providers as never,
    pricing as never,
    ledger as never,
    refunds as never,
    cfg as never,
  );
  return {
    svc,
    queue,
    jobs,
    cfg,
    pricing,
    ledger,
    refunds,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const wav = (seconds = 3) => ({ buffer: makeWav({ seconds }), mimetype: 'audio/wav' });

async function errorOf(p: Promise<unknown>): Promise<HttpException> {
  return p.then(
    () => {
      throw new Error('expected a failure');
    },
    (e: HttpException) => e,
  );
}

describe('CaptionsService.start', () => {
  it('refuses a suspended account before anything else', async () => {
    const { svc, ledger, cleanup } = build();
    expect((await errorOf(svc.start(user('suspended'), wav(), undefined, KEY))).getResponse()).toMatchObject({
      code: 'ACCOUNT_SUSPENDED',
    });
    expect(ledger.post).not.toHaveBeenCalled();
    cleanup();
  });

  it('answers 503 when no provider is active, charging nothing', async () => {
    const { svc, ledger, cleanup } = build({ active: false });
    expect((await errorOf(svc.start(user(), wav(), undefined, KEY))).getStatus()).toBe(503);
    expect(ledger.post).not.toHaveBeenCalled();
    cleanup();
  });

  it('refuses audio that is not WAV with 415, naming what it got', async () => {
    const { svc, ledger, cleanup } = build();
    const error = await errorOf(
      svc.start(user(), { buffer: Buffer.from('x'), mimetype: 'application/octet-stream' }, undefined, KEY),
    );
    expect(error.getStatus()).toBe(415);
    expect(error.getResponse()).toMatchObject({
      code: 'UNSUPPORTED_MEDIA',
      message: expect.stringContaining('application/octet-stream'),
    });
    expect(ledger.post).not.toHaveBeenCalled();
    cleanup();
  });

  it('refuses a WAV it cannot read with 422 INVALID_AUDIO', async () => {
    const { svc, ledger, cleanup } = build();
    const error = await errorOf(
      svc.start(user(), { buffer: Buffer.from('RIFF....WAVE'), mimetype: 'audio/wav' }, undefined, KEY),
    );
    expect(error.getResponse()).toMatchObject({ code: 'INVALID_AUDIO' });
    expect(ledger.post).not.toHaveBeenCalled();
    cleanup();
  });

  it('prices the duration it measured, charges it against the job, then writes and queues the audio', async () => {
    const { svc, queue, cfg, pricing, ledger, cleanup } = build();
    const view = await svc.start(user(), wav(3), 'en', KEY);
    const jobId = captionJobId('u1', KEY);

    expect(pricing.price).toHaveBeenCalledWith('auto_captions', expect.closeTo(3, 6));
    expect(ledger.post).toHaveBeenCalledWith({
      userId: 'u1',
      type: 'feature_charge',
      amount: -6,
      reference: jobId,
      requireActive: true,
      metadata: {
        feature: 'auto_captions',
        durationSeconds: expect.closeTo(3, 6),
        pricingRuleId: 'r1',
        pricingVersion: 3,
      },
    });
    const filePath = join(cfg.tmpDir, `${jobId}.audio`);
    expect(readFileSync(filePath).length).toBeGreaterThan(0);
    expect(queue.add).toHaveBeenCalledWith(
      'transcribe',
      { userId: 'u1', filePath, mimeType: 'audio/wav', language: 'en', credits: 6 },
      {
        jobId,
        attempts: 2,
        backoff: { type: 'fixed', delay: 2_000 },
        removeOnComplete: { age: 180 },
        removeOnFail: { age: 180 },
      },
    );
    expect(view).toEqual({ jobId, status: 'queued', pollAfterMs: 1500, charged: { credits: 6, balance: 88 } });
    cleanup();
  });

  it('writes and queues nothing when the balance is too low', async () => {
    const { svc, queue, cfg, ledger, cleanup } = build();
    ledger.post.mockRejectedValue(
      appError(402, ErrorCode.INSUFFICIENT_CREDITS, 'Not enough credits.', { required: 6, balance: 2 }),
    );
    expect((await errorOf(svc.start(user(), wav(), undefined, KEY))).getStatus()).toBe(402);
    expect(queue.add).not.toHaveBeenCalled();
    expect(() => readdirSync(cfg.tmpDir)).toThrow();
    cleanup();
  });

  it('runs a free job without touching the ledger', async () => {
    const { svc, ledger, cleanup } = build({ credits: 0 });
    const view = await svc.start(user(), wav(), undefined, KEY);
    expect(ledger.post).not.toHaveBeenCalled();
    expect(view).not.toHaveProperty('charged');
    cleanup();
  });

  it('answers a resend with the same key from the existing job, charging nothing more', async () => {
    const { svc, ledger, queue, cleanup } = build();
    const first = await svc.start(user(), wav(), undefined, KEY);
    const second = await svc.start(user(), wav(), undefined, KEY);
    expect(second.jobId).toBe(first.jobId);
    expect(ledger.post).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('refunds and removes the audio if the job cannot be queued', async () => {
    const { svc, queue, cfg, refunds, cleanup } = build();
    queue.add.mockRejectedValueOnce(new Error('Redis down'));
    await expect(svc.start(user(), wav(), undefined, KEY)).rejects.toThrow('Redis down');
    expect(readdirSync(cfg.tmpDir)).toEqual([]);
    expect(refunds.refund).toHaveBeenCalledWith('u1', captionJobId('u1', KEY), 6, 'queue_failed');
    cleanup();
  });

  posixIt('keeps the audio private to the server user', async () => {
    const { svc, cfg, cleanup } = build();
    const { jobId } = await svc.start(user(), wav(), undefined, KEY);
    expect(statSync(join(cfg.tmpDir, `${jobId}.audio`)).mode & 0o777).toBe(0o600);
    cleanup();
  });
});

describe('CaptionsService.status', () => {
  async function started(opts?: { ttl?: number }) {
    const ctx = build(opts);
    const { jobId } = await ctx.svc.start(user(), wav(), undefined, KEY);
    return { ...ctx, jobId, job: ctx.jobs.get(jobId) as FakeJob };
  }

  it.each([
    ['waiting', 'queued'],
    ['delayed', 'queued'],
    ['active', 'processing'],
  ])('reports a %s job as %s', async (state, status) => {
    const { svc, jobId, job, cleanup } = await started();
    job.state = state;
    await expect(svc.status(user(), jobId)).resolves.toEqual({ jobId, status, pollAfterMs: 1500 });
    cleanup();
  });

  it('returns the result of a completed job', async () => {
    const { svc, jobId, job, cleanup } = await started();
    Object.assign(job, { state: 'completed', returnvalue: RESULT, finishedOn: Date.now() });
    await expect(svc.status(user(), jobId)).resolves.toEqual({ jobId, status: 'completed', result: RESULT });
    cleanup();
  });

  it("hides another user's job", async () => {
    const { svc, jobId, cleanup } = await started();
    const other = { id: 'u2', sessionId: 's2', deviceId: 'dev-2', status: 'active' } as never;
    await expect(svc.status(other, jobId)).rejects.toBeInstanceOf(NotFoundException);
    cleanup();
  });

  it('404s a result older than the TTL', async () => {
    const { svc, jobId, job, cleanup } = await started({ ttl: 180 });
    Object.assign(job, { state: 'completed', returnvalue: RESULT, finishedOn: Date.now() - 181_000 });
    await expect(svc.status(user(), jobId)).rejects.toBeInstanceOf(NotFoundException);
    cleanup();
  });
});
