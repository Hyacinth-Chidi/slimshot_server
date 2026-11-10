import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HttpException } from '@nestjs/common';

import { speechJobId } from './speech.constants';
import { SpeechService } from './speech.service';

const user = (status = 'active') => ({ id: 'u1', sessionId: 's1', deviceId: 'dev-1', status }) as never;
const KEY = 'key-12345678';

interface FakeJob {
  id: string;
  data: { userId: string; items: { id: string; text: string }[] };
  state: string;
  returnvalue?: unknown;
  failedReason?: string;
  finishedOn?: number;
  getState: () => Promise<string>;
}

function build({ active = true, credits = 3, replayed = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'speech-'));
  const jobs = new Map<string, FakeJob>();
  const queue = {
    getJob: jest.fn(async (id: string) => jobs.get(id)),
    add: jest.fn(async (_name: string, data: FakeJob['data'], opts: { jobId: string }) => {
      const job: FakeJob = { id: opts.jobId, data, state: 'waiting', getState: async () => job.state };
      jobs.set(opts.jobId, job);
      return job;
    }),
  };
  const credentials = { getActiveTextToSpeech: jest.fn(async () => (active ? { adapter: {}, apiKey: 'k' } : null)) };
  const voices = {
    voiceForJob: jest.fn(async (id: string) => (id === 'v1' ? { id: 'v1', providerVoiceId: 'eve' } : null)),
  };
  const pricing = { price: jest.fn(async () => ({ credits, rule: { id: 'r1', version: 2 } })) };
  const ledger = { post: jest.fn(async () => ({ transaction: { balanceAfter: 37 }, replayed })) };
  const refunds = { refund: jest.fn(async () => undefined) };
  const cfg = { tmpDir: dir, keepMinutes: 60, maxItems: 100, maxItemCharacters: 2000, maxRequestCharacters: 20000 };
  const svc = new SpeechService(
    queue as never,
    credentials as never,
    voices as never,
    pricing as never,
    ledger as never,
    refunds as never,
    cfg as never,
  );
  return { svc, queue, jobs, pricing, ledger, refunds, cfg, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function errorOf(p: Promise<unknown>): Promise<HttpException> {
  return p.then(
    () => {
      throw new Error('expected a failure');
    },
    (e: HttpException) => e,
  );
}

const items = (...texts: string[]) => texts.map((text, i) => ({ id: `t${i + 1}`, text }));

describe('SpeechService.start', () => {
  it("a request's characters are the code points of its trimmed texts", async () => {
    const { svc, pricing, cleanup } = build();
    await svc.start(user(), { voiceId: 'v1', items: items(' hello ', 'héllo 👍🏽') }, KEY);
    expect(pricing.price).toHaveBeenCalledWith('text_to_speech', 13);
    cleanup();
  });

  it.each([
    ['an empty text', { voiceId: 'v1', items: items('hi', '   ') }, 422, 'VALIDATION_FAILED'],
    ['a text over 2000 characters', { voiceId: 'v1', items: items('x'.repeat(2001)) }, 413, 'TEXT_TOO_LONG'],
    ['more than 100 items', { voiceId: 'v1', items: items(...Array<string>(101).fill('hi')) }, 422, 'VALIDATION_FAILED'],
    ['more than 20000 characters', { voiceId: 'v1', items: items(...Array<string>(11).fill('x'.repeat(2000))) }, 413, 'TEXT_TOO_LONG'],
    ['a duplicate item id', { voiceId: 'v1', items: [{ id: 'a', text: 'hi' }, { id: 'a', text: 'yo' }] }, 422, 'VALIDATION_FAILED'],
    ['an ill-formed item id', { voiceId: 'v1', items: [{ id: '../x', text: 'hi' }] }, 422, 'VALIDATION_FAILED'],
  ])('refuses %s, charging nothing', async (_label, request, status, code) => {
    const { svc, ledger, queue, cleanup } = build();
    const error = await errorOf(svc.start(user(), request, KEY));
    expect(error.getStatus()).toBe(status);
    expect(error.getResponse()).toMatchObject({ code });
    expect(ledger.post).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    cleanup();
  });

  it('refuses a voice that is unknown or switched off', async () => {
    const { svc, ledger, cleanup } = build();
    const error = await errorOf(svc.start(user(), { voiceId: 'v9', items: items('hi') }, KEY));
    expect(error.getStatus()).toBe(404);
    expect(error.getResponse()).toMatchObject({ code: 'VOICE_NOT_FOUND' });
    expect(ledger.post).not.toHaveBeenCalled();
    cleanup();
  });

  it('refuses when no voice provider is active', async () => {
    const { svc, cleanup } = build({ active: false });
    const error = await errorOf(svc.start(user(), { voiceId: 'v1', items: items('hi') }, KEY));
    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toMatchObject({ code: 'TTS_UNAVAILABLE' });
    cleanup();
  });

  it('refuses a suspended account', async () => {
    const { svc, cleanup } = build();
    const error = await errorOf(svc.start(user('suspended'), { voiceId: 'v1', items: items('hi') }, KEY));
    expect(error.getStatus()).toBe(403);
    cleanup();
  });

  it('charges before queueing and returns the charge', async () => {
    const { svc, ledger, queue, cleanup } = build();
    const view = await svc.start(user(), { voiceId: 'v1', items: items(' Hello ') }, KEY);
    const jobId = speechJobId('u1', KEY);
    expect(view).toEqual({ jobId, status: 'queued', pollAfterMs: 1500, charged: { credits: 3, balance: 37 } });
    expect(ledger.post).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', type: 'feature_charge', amount: -3, reference: jobId, requireActive: true }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      'synthesize',
      { userId: 'u1', voiceId: 'v1', providerVoiceId: 'eve', items: [{ id: 't1', text: 'Hello' }], credits: 3 },
      expect.objectContaining({ jobId }),
    );
    expect(ledger.post.mock.invocationCallOrder[0]).toBeLessThan(queue.add.mock.invocationCallOrder[0]);
    cleanup();
  });

  it('the same key answers with the same job, no second charge', async () => {
    const { svc, ledger, cleanup } = build();
    const first = await svc.start(user(), { voiceId: 'v1', items: items('hi') }, KEY);
    const again = await svc.start(user(), { voiceId: 'v1', items: items('hi') }, KEY);
    expect(again.jobId).toBe(first.jobId);
    expect(ledger.post).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('a key whose charge is already spent is refused', async () => {
    const { svc, queue, cleanup } = build({ replayed: true });
    const error = await errorOf(svc.start(user(), { voiceId: 'v1', items: items('hi') }, KEY));
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(queue.add).not.toHaveBeenCalled();
    cleanup();
  });

  it("a resend after its job's voices were deleted is refused, never answered with that job", async () => {
    const { svc, jobs, ledger, queue, cleanup } = build();
    const { jobId } = await svc.start(user(), { voiceId: 'v1', items: items('hi') }, KEY);
    const job = jobs.get(jobId) as FakeJob;
    job.state = 'completed';
    job.finishedOn = Date.now() - 61 * 60_000;
    job.returnvalue = { items: [{ id: 't1' }] };

    const error = await errorOf(svc.start(user(), { voiceId: 'v1', items: items('hi') }, KEY));
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(ledger.post).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('a queue failure refunds', async () => {
    const { svc, queue, refunds, cleanup } = build();
    queue.add.mockRejectedValueOnce(new Error('redis down'));
    await expect(svc.start(user(), { voiceId: 'v1', items: items('hi') }, KEY)).rejects.toThrow('redis down');
    expect(refunds.refund).toHaveBeenCalledWith('u1', speechJobId('u1', KEY), 3, 'queue_failed');
    cleanup();
  });
});

describe('SpeechService.status and audioPath', () => {
  function finished(jobs: Map<string, FakeJob>, jobId: string, finishedOn = Date.now()) {
    const job = jobs.get(jobId) as FakeJob;
    job.state = 'completed';
    job.finishedOn = finishedOn;
    job.returnvalue = { items: [{ id: 't1' }] };
  }

  it('reports a finished job with its items', async () => {
    const { svc, jobs, cleanup } = build();
    const { jobId } = await svc.start(user(), { voiceId: 'v1', items: items('hi') }, KEY);
    finished(jobs, jobId);
    await expect(svc.status(user(), jobId)).resolves.toEqual({ jobId, status: 'completed', items: [{ id: 't1' }] });
    cleanup();
  });

  it("serves the item's file to its owner", async () => {
    const { svc, jobs, dir, cleanup } = build();
    const { jobId } = await svc.start(user(), { voiceId: 'v1', items: items('hi') }, KEY);
    finished(jobs, jobId);
    mkdirSync(join(dir, jobId));
    writeFileSync(join(dir, jobId, 't1.mp3'), 'mp3');
    await expect(svc.audioPath(user(), jobId, 't1')).resolves.toBe(join(dir, jobId, 't1.mp3'));
    cleanup();
  });

  it("another user's job, an unknown item and a swept file are 404", async () => {
    const { svc, jobs, dir, cleanup } = build();
    const { jobId } = await svc.start(user(), { voiceId: 'v1', items: items('hi') }, KEY);
    finished(jobs, jobId);
    mkdirSync(join(dir, jobId));
    writeFileSync(join(dir, jobId, 't1.mp3'), 'mp3');
    const other = { id: 'u2', sessionId: 's2', deviceId: 'dev-2', status: 'active' } as never;

    expect((await errorOf(svc.status(other, jobId))).getStatus()).toBe(404);
    expect((await errorOf(svc.audioPath(other, jobId, 't1'))).getStatus()).toBe(404);
    expect((await errorOf(svc.audioPath(user(), jobId, 't2'))).getStatus()).toBe(404);
    expect((await errorOf(svc.audioPath(user(), 'tts_nope', 't1'))).getStatus()).toBe(404);

    rmSync(join(dir, jobId), { recursive: true, force: true });
    expect((await errorOf(svc.audioPath(user(), jobId, 't1'))).getStatus()).toBe(404);
    cleanup();
  });

  it('a job finished longer ago than the files are kept is gone', async () => {
    const { svc, jobs, cleanup } = build();
    const { jobId } = await svc.start(user(), { voiceId: 'v1', items: items('hi') }, KEY);
    finished(jobs, jobId, Date.now() - 61 * 60_000);
    expect((await errorOf(svc.status(user(), jobId))).getStatus()).toBe(404);
    cleanup();
  });
});
