import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';

import { ProviderKind } from '../../generated/prisma/enums';
import { ProviderError } from '../providers/provider-error';
import { CaptionWorker } from './caption.worker';

const RESULT = { provider: 'deepgram', language: 'en', durationSeconds: 1, text: 'Hi.', words: [] };

function build(transcribe: jest.Mock | null, opts: { pathIsDirectory?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'worker-'));
  const filePath = join(dir, 'cap_x.audio');
  if (opts.pathIsDirectory) mkdirSync(filePath);
  else writeFileSync(filePath, 'audio');

  const credentials = {
    getActive: jest.fn(async () =>
      transcribe ? { adapter: { kind: 'deepgram', transcribe }, apiKey: 'dg-key-123' } : null,
    ),
  };
  const refunds = { refund: jest.fn(async () => undefined) };
  const worker = new CaptionWorker(credentials as never, refunds as never, { concurrency: 4 } as never);
  const job = (attemptsMade = 0) =>
    ({
      id: 'cap_x',
      data: { userId: 'u1', filePath, mimeType: 'audio/wav', language: 'en', credits: 6 },
      attemptsMade,
      opts: { attempts: 2 },
    }) as never;

  return { worker, job, filePath, refunds, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('CaptionWorker.process', () => {
  it('returns the result, deletes the audio and refunds nothing', async () => {
    const transcribe = jest.fn(async () => RESULT);
    const { worker, job, filePath, refunds, cleanup } = build(transcribe);
    await expect(worker.process(job())).resolves.toEqual(RESULT);
    expect(transcribe).toHaveBeenCalledWith({ filePath, mimeType: 'audio/wav', language: 'en' }, 'dg-key-123');
    expect(existsSync(filePath)).toBe(false);
    expect(refunds.refund).not.toHaveBeenCalled();
    cleanup();
  });

  it('refunds and fails for good on a provider refusal', async () => {
    const transcribe = jest.fn(async () => {
      throw new ProviderError(ProviderKind.deepgram, 400, 'Corrupt audio');
    });
    const { worker, job, filePath, refunds, cleanup } = build(transcribe);
    const error = await worker.process(job()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(existsSync(filePath)).toBe(false);
    expect(refunds.refund).toHaveBeenCalledWith('u1', 'cap_x', 6, 'job_failed');
    cleanup();
  });

  it('keeps the audio and the charge for the retry after a first outage', async () => {
    const transcribe = jest.fn(async () => {
      throw new ProviderError(ProviderKind.deepgram, 503, 'Service unavailable');
    });
    const { worker, job, filePath, refunds, cleanup } = build(transcribe);
    await worker.process(job(0)).catch(() => undefined);
    expect(existsSync(filePath)).toBe(true);
    expect(refunds.refund).not.toHaveBeenCalled();
    cleanup();
  });

  it('refunds after the last attempt fails', async () => {
    const transcribe = jest.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const { worker, job, filePath, refunds, cleanup } = build(transcribe);
    await worker.process(job(1)).catch(() => undefined);
    expect(existsSync(filePath)).toBe(false);
    expect(refunds.refund).toHaveBeenCalledWith('u1', 'cap_x', 6, 'job_failed');
    cleanup();
  });

  it('refunds when no provider is active at run time', async () => {
    const { worker, job, refunds, cleanup } = build(null);
    const error = await worker.process(job()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(refunds.refund).toHaveBeenCalledWith('u1', 'cap_x', 6, 'job_failed');
    cleanup();
  });

  it('still returns a paid result when the audio cannot be deleted', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const transcribe = jest.fn(async () => RESULT);
    const { worker, job, refunds, cleanup } = build(transcribe, { pathIsDirectory: true });
    await expect(worker.process(job())).resolves.toEqual(RESULT);
    expect(refunds.refund).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    cleanup();
  });

  it('never writes the key to the log', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const transcribe = jest.fn(async () => {
      throw new TypeError('Headers.append: "Token dg-key-123" is an invalid header value.');
    });
    const { worker, job, cleanup } = build(transcribe);
    await worker.process(job(1)).catch(() => undefined);
    const logged = warn.mock.calls.map((args) => String(args[0])).join('\n');
    expect(logged).toContain('[redacted]');
    expect(logged).not.toContain('dg-key-123');
    warn.mockRestore();
    cleanup();
  });
});

describe('CaptionWorker.onApplicationBootstrap', () => {
  it('applies the configured concurrency to the BullMQ worker', () => {
    const { worker, cleanup } = build(jest.fn());
    const bull = { concurrency: 1 };
    (worker as unknown as { _worker: typeof bull })._worker = bull;
    worker.onApplicationBootstrap();
    expect(bull.concurrency).toBe(4);
    cleanup();
  });
});
