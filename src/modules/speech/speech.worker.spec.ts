import { existsSync, mkdtempSync, readdirSync, readFileSync, type ReadStream, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Readable } from 'node:stream';

import { Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';

import { probeAudio } from '../../core/storage/audio-probe';
import { ProviderKind } from '../../generated/prisma/enums';
import { ProviderError } from '../providers/provider-error';
import { SpeechWorker } from './speech.worker';

// music-metadata is ESM-only and cannot load under Jest; its own spec runs it for real.
jest.mock('../../core/storage/audio-probe', () => ({ probeAudio: jest.fn() }));
const probe = probeAudio as jest.MockedFunction<typeof probeAudio>;
/** The length the probe reads from each voice, by its file's name. */
const LENGTHS_MS: Record<string, number> = { 'a.mp3': 1_250, 'b.mp3': 2_500 };

beforeEach(() => {
  probe.mockReset().mockImplementation(async (stream: Readable) => {
    const name = basename(String((stream as ReadStream).path));
    await closed(stream);
    return { format: 'mp3', mimeType: 'audio/mpeg', durationMs: LENGTHS_MS[name] };
  });
});

/** Lets the stream open and close, as the real probe does, so nothing touches the file after a test. */
function closed(stream: Readable): Promise<void> {
  return new Promise((resolve) => {
    stream.once('close', () => resolve());
    stream.once('error', () => resolve());
    stream.destroy();
  });
}

const posixIt = process.platform === 'win32' ? it.skip : it;
const JOB_ID = `tts_${'a'.repeat(32)}`;
const ITEMS = [
  { id: 'a', text: 'Hello there.' },
  { id: 'b', text: 'Second line.' },
];

function build(synthesize: jest.Mock | null) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'speech-worker-'));
  const credentials = {
    getActiveTextToSpeech: jest.fn(async () =>
      synthesize ? { adapter: { kind: 'xai', synthesize }, apiKey: 'xai-key-123' } : null,
    ),
  };
  const refunds = { refund: jest.fn(async () => undefined) };
  const worker = new SpeechWorker(credentials as never, refunds as never, { tmpDir, concurrency: 3 } as never);
  const job = (attemptsMade = 0) =>
    ({
      id: JOB_ID,
      data: { userId: 'u1', voiceId: 'v1', providerVoiceId: 'eve', items: ITEMS, credits: 5 },
      attemptsMade,
      opts: { attempts: 2 },
    }) as never;
  const dir = join(tmpDir, JOB_ID);
  return { worker, job, dir, refunds, cleanup: () => rmSync(tmpDir, { recursive: true, force: true }) };
}

const spoken = (text: string) => Buffer.from(`mp3:${text}`);

describe('SpeechWorker.process', () => {
  it('writes one MP3 per item under its job', async () => {
    const synthesize = jest.fn(async ({ text }: { text: string }) => spoken(text));
    const { worker, job, dir, refunds, cleanup } = build(synthesize);

    await expect(worker.process(job())).resolves.toEqual({
      items: [
        { id: 'a', durationSeconds: 1.25 },
        { id: 'b', durationSeconds: 2.5 },
      ],
    });
    expect(synthesize.mock.calls).toEqual([
      [{ text: 'Hello there.', voiceId: 'eve' }, 'xai-key-123'],
      [{ text: 'Second line.', voiceId: 'eve' }, 'xai-key-123'],
    ]);
    expect(readFileSync(join(dir, 'a.mp3'), 'utf8')).toBe('mp3:Hello there.');
    expect(readFileSync(join(dir, 'b.mp3'), 'utf8')).toBe('mp3:Second line.');
    // Written whole or not at all: nothing half-written is left beside them.
    expect(readdirSync(dir).sort()).toEqual(['a.mp3', 'b.mp3']);
    expect(refunds.refund).not.toHaveBeenCalled();
    cleanup();
  });

  posixIt('keeps the voices readable by the server alone', async () => {
    const synthesize = jest.fn(async ({ text }: { text: string }) => spoken(text));
    const { worker, job, dir, cleanup } = build(synthesize);
    await worker.process(job());
    expect(statSync(join(dir, 'a.mp3')).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    cleanup();
  });

  it('any item failing fails the job and refunds it all', async () => {
    const synthesize = jest
      .fn()
      .mockResolvedValueOnce(spoken('Hello there.'))
      .mockRejectedValueOnce(new ProviderError(ProviderKind.xai, 400, 'Text not allowed'));
    const { worker, job, dir, refunds, cleanup } = build(synthesize);

    const error = await worker.process(job()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect((error as Error).message).toBe('PROVIDER_FAILED: Text not allowed');
    expect(existsSync(dir)).toBe(false);
    expect(refunds.refund).toHaveBeenCalledWith('u1', JOB_ID, 5, 'job_failed');
    cleanup();
  });

  it('a provider switched off while queued fails and refunds', async () => {
    const { worker, job, refunds, cleanup } = build(null);
    const error = await worker.process(job()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect((error as Error).message).toMatch(/^TTS_UNAVAILABLE: /);
    expect(refunds.refund).toHaveBeenCalledWith('u1', JOB_ID, 5, 'job_failed');
    cleanup();
  });

  it('a refusal is not retried; an outage is, once', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const refused = build(jest.fn(async () => Promise.reject(new ProviderError(ProviderKind.xai, 422, 'Bad voice'))));
    expect(await refused.worker.process(refused.job(0)).catch((e: unknown) => e)).toBeInstanceOf(UnrecoverableError);
    expect(refused.refunds.refund).toHaveBeenCalledTimes(1);
    refused.cleanup();

    const outage = jest.fn(async () => Promise.reject(new ProviderError(ProviderKind.xai, 503, 'Service unavailable')));
    const down = build(outage);
    const first = await down.worker.process(down.job(0)).catch((e: unknown) => e);
    expect(first).not.toBeInstanceOf(UnrecoverableError);
    expect((first as Error).message).toBe('PROVIDER_FAILED: Service unavailable');
    expect(down.refunds.refund).not.toHaveBeenCalled();

    const last = await down.worker.process(down.job(1)).catch((e: unknown) => e);
    expect(last).not.toBeInstanceOf(UnrecoverableError);
    expect(down.refunds.refund).toHaveBeenCalledWith('u1', JOB_ID, 5, 'job_failed');
    expect(existsSync(down.dir)).toBe(false);
    down.cleanup();

    warn.mockRestore();
  });

  it('a retry keeps what the first attempt already made', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const synthesize = jest
      .fn()
      .mockResolvedValueOnce(spoken('Hello there.'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(spoken('Second line.'));
    const { worker, job, dir, refunds, cleanup } = build(synthesize);

    await worker.process(job(0)).catch(() => undefined);
    await expect(worker.process(job(1))).resolves.toEqual({
      items: [
        { id: 'a', durationSeconds: 1.25 },
        { id: 'b', durationSeconds: 2.5 },
      ],
    });
    // Three calls, not four: the first text was not paid for twice.
    expect(synthesize).toHaveBeenCalledTimes(3);
    expect(readFileSync(join(dir, 'a.mp3'), 'utf8')).toBe('mp3:Hello there.');
    expect(readFileSync(join(dir, 'b.mp3'), 'utf8')).toBe('mp3:Second line.');
    expect(refunds.refund).not.toHaveBeenCalled();
    warn.mockRestore();
    cleanup();
  });

  it('a voice whose length cannot be read is made again, once', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const synthesize = jest.fn(async ({ text }: { text: string }) => spoken(text));
    const { worker, job, dir, refunds, cleanup } = build(synthesize);
    probe.mockImplementationOnce(async (stream: Readable) => {
      await closed(stream);
      throw new Error('not audio');
    });

    const first = await worker.process(job(0)).catch((e: unknown) => e);
    expect(first).not.toBeInstanceOf(UnrecoverableError);
    expect((first as Error).message).toBe('PROVIDER_FAILED: The voice provider sent audio that could not be read.');
    // The unreadable file is gone, so the retry asks for it again rather than keeping it.
    expect(existsSync(join(dir, 'a.mp3'))).toBe(false);
    expect(refunds.refund).not.toHaveBeenCalled();

    await expect(worker.process(job(1))).resolves.toEqual({
      items: [
        { id: 'a', durationSeconds: 1.25 },
        { id: 'b', durationSeconds: 2.5 },
      ],
    });
    expect(synthesize).toHaveBeenCalledTimes(3);
    warn.mockRestore();
    cleanup();
  });

  it('never writes the key to the log', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const synthesize = jest.fn(async () => {
      throw new TypeError('Headers.append: "Bearer xai-key-123" is an invalid header value.');
    });
    const { worker, job, cleanup } = build(synthesize);
    const error = await worker.process(job(1)).catch((e: unknown) => e);
    const logged = warn.mock.calls.map((args) => String(args[0])).join('\n');
    expect(logged).toContain('[redacted]');
    expect(logged).not.toContain('xai-key-123');
    expect((error as Error).message).not.toContain('xai-key-123');
    warn.mockRestore();
    cleanup();
  });
});

describe('SpeechWorker.onApplicationBootstrap', () => {
  it('applies the configured concurrency to the BullMQ worker', () => {
    const { worker, cleanup } = build(jest.fn());
    const bull = { concurrency: 1 };
    (worker as unknown as { _worker: typeof bull })._worker = bull;
    worker.onApplicationBootstrap();
    expect(bull.concurrency).toBe(3);
    cleanup();
  });
});
