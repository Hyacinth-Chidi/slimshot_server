import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HttpException, NotFoundException } from '@nestjs/common';

import { ErrorCode } from '../../core/errors/error-codes';
import { captionJobId } from './captions.constants';
import { CaptionsService } from './captions.service';

const posixIt = process.platform === 'win32' ? it.skip : it;
const device = { id: 'dev-1' };
const KEY = 'key-12345678';
const RESULT = { provider: 'deepgram', language: 'en', durationSeconds: 1, text: 'Hi.', words: [] };

interface FakeJob {
  id: string;
  data: { deviceId: string; filePath: string };
  state: string;
  returnvalue?: unknown;
  failedReason?: string;
  finishedOn?: number;
  getState: () => Promise<string>;
}

function build({ active = true, ttl = 180 } = {}) {
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
  const credentials = { getActive: jest.fn(async () => (active ? { adapter: {}, apiKey: 'k' } : null)) };
  const cfg = { tmpDir: join(dir, 'audio'), resultTtlSeconds: ttl };
  const svc = new CaptionsService(queue as never, credentials as never, cfg as never);
  return { svc, queue, jobs, cfg, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const audio = (text: string) => ({ buffer: Buffer.from(text), mimetype: 'audio/mp4' });

describe('CaptionsService.start', () => {
  it('refuses with CAPTIONS_UNAVAILABLE when no provider is active, writing nothing', async () => {
    const { svc, queue, cfg, cleanup } = build({ active: false });
    const error = await svc.start(device, audio('a'), undefined, KEY).catch((e: unknown) => e);

    expect((error as HttpException).getStatus()).toBe(503);
    expect((error as HttpException).getResponse()).toMatchObject({ code: ErrorCode.CAPTIONS_UNAVAILABLE });
    expect(queue.add).not.toHaveBeenCalled();
    expect(() => readdirSync(cfg.tmpDir)).toThrow();
    cleanup();
  });

  it('writes the audio and queues a job whose id comes from device and key', async () => {
    const { svc, queue, cfg, cleanup } = build();
    const view = await svc.start(device, audio('first'), 'en', KEY);
    const jobId = captionJobId('dev-1', KEY);

    expect(view).toEqual({ jobId, status: 'queued', pollAfterMs: 1500 });
    const filePath = join(cfg.tmpDir, `${jobId}.audio`);
    expect(readFileSync(filePath, 'utf8')).toBe('first');
    expect(queue.add).toHaveBeenCalledWith(
      'transcribe',
      { deviceId: 'dev-1', filePath, mimeType: 'audio/mp4', language: 'en' },
      {
        jobId,
        attempts: 2,
        backoff: { type: 'fixed', delay: 2_000 },
        removeOnComplete: { age: 180 },
        removeOnFail: { age: 180 },
      },
    );
    cleanup();
  });

  posixIt('keeps the audio private to the server user', async () => {
    const { svc, cfg, cleanup } = build();
    const { jobId } = await svc.start(device, audio('x'), undefined, KEY);
    expect(statSync(join(cfg.tmpDir, `${jobId}.audio`)).mode & 0o777).toBe(0o600);
    expect(statSync(cfg.tmpDir).mode & 0o777).toBe(0o700);
    cleanup();
  });

  it('returns the existing job for a resend and drops the second upload unwritten', async () => {
    const { svc, queue, cfg, cleanup } = build();
    const first = await svc.start(device, audio('first'), undefined, KEY);
    const second = await svc.start(device, audio('second'), undefined, KEY);

    expect(second.jobId).toBe(first.jobId);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(cfg.tmpDir, `${first.jobId}.audio`), 'utf8')).toBe('first');
    cleanup();
  });

  it('removes the audio again if the job cannot be queued', async () => {
    const { svc, queue, cfg, cleanup } = build();
    queue.add.mockRejectedValueOnce(new Error('Redis down'));

    await expect(svc.start(device, audio('x'), undefined, KEY)).rejects.toThrow('Redis down');
    expect(readdirSync(cfg.tmpDir)).toEqual([]);
    cleanup();
  });
});

describe('CaptionsService.status', () => {
  async function started(opts?: { ttl?: number }) {
    const ctx = build(opts);
    const { jobId } = await ctx.svc.start(device, audio('x'), undefined, KEY);
    return { ...ctx, jobId, job: ctx.jobs.get(jobId) as FakeJob };
  }

  it.each([
    ['waiting', 'queued'],
    ['delayed', 'queued'],
    ['prioritized', 'queued'],
    ['active', 'processing'],
  ])('reports a %s job as %s', async (state, status) => {
    const { svc, jobId, job, cleanup } = await started();
    job.state = state;
    await expect(svc.status(device, jobId)).resolves.toEqual({ jobId, status, pollAfterMs: 1500 });
    cleanup();
  });

  it('returns the result of a completed job', async () => {
    const { svc, jobId, job, cleanup } = await started();
    Object.assign(job, { state: 'completed', returnvalue: RESULT, finishedOn: Date.now() });
    await expect(svc.status(device, jobId)).resolves.toEqual({ jobId, status: 'completed', result: RESULT });
    cleanup();
  });

  it('returns the decoded error of a failed job', async () => {
    const { svc, jobId, job, cleanup } = await started();
    Object.assign(job, { state: 'failed', failedReason: 'PROVIDER_FAILED: Corrupt audio', finishedOn: Date.now() });
    await expect(svc.status(device, jobId)).resolves.toEqual({
      jobId,
      status: 'failed',
      error: { code: 'PROVIDER_FAILED', message: 'Corrupt audio' },
    });
    cleanup();
  });

  it('hides another device\'s job', async () => {
    const { svc, jobId, cleanup } = await started();
    await expect(svc.status({ id: 'dev-2' }, jobId)).rejects.toBeInstanceOf(NotFoundException);
    cleanup();
  });

  it('404s a malformed id without asking the queue', async () => {
    const { svc, queue, cleanup } = await started();
    queue.getJob.mockClear();
    await expect(svc.status(device, '../../etc/passwd')).rejects.toBeInstanceOf(NotFoundException);
    expect(queue.getJob).not.toHaveBeenCalled();
    cleanup();
  });

  it('404s a result older than the TTL even if BullMQ has not pruned it yet', async () => {
    const { svc, jobId, job, cleanup } = await started({ ttl: 180 });
    Object.assign(job, { state: 'completed', returnvalue: RESULT, finishedOn: Date.now() - 181_000 });
    await expect(svc.status(device, jobId)).rejects.toBeInstanceOf(NotFoundException);
    cleanup();
  });

  it('404s a job BullMQ no longer knows', async () => {
    const { svc, jobId, job, cleanup } = await started();
    job.state = 'unknown';
    await expect(svc.status(device, jobId)).rejects.toBeInstanceOf(NotFoundException);
    cleanup();
  });
});
