import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';

import { ProviderKind } from '../../generated/prisma/enums';
import { ProviderError } from '../providers/provider-error';
import { CaptionWorker } from './caption.worker';

const RESULT = { provider: 'deepgram', language: 'en', durationSeconds: 1, text: 'Hi.', words: [] };

function build(transcribe: jest.Mock | null) {
  const dir = mkdtempSync(join(tmpdir(), 'worker-'));
  const filePath = join(dir, 'cap_x.audio');
  writeFileSync(filePath, 'audio');

  const credentials = {
    getActive: jest.fn(async () =>
      transcribe ? { adapter: { kind: 'deepgram', transcribe }, apiKey: 'dg-key-123' } : null,
    ),
  };
  const worker = new CaptionWorker(credentials as never, { concurrency: 4 } as never);
  const job = (attemptsMade = 0) =>
    ({
      id: 'cap_x',
      data: { deviceId: 'dev-1', filePath, mimeType: 'audio/mp4', language: 'en' },
      attemptsMade,
      opts: { attempts: 2 },
    }) as never;

  return { worker, job, filePath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('CaptionWorker.process', () => {
  it('returns the result and deletes the audio', async () => {
    const transcribe = jest.fn(async () => RESULT);
    const { worker, job, filePath, cleanup } = build(transcribe);

    await expect(worker.process(job())).resolves.toEqual(RESULT);
    expect(transcribe).toHaveBeenCalledWith({ filePath, mimeType: 'audio/mp4', language: 'en' }, 'dg-key-123');
    expect(existsSync(filePath)).toBe(false);
    cleanup();
  });

  it('fails for good on a provider refusal and deletes the audio', async () => {
    const transcribe = jest.fn(async () => {
      throw new ProviderError(ProviderKind.deepgram, 400, 'Corrupt audio');
    });
    const { worker, job, filePath, cleanup } = build(transcribe);

    const error = await worker.process(job()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect((error as Error).message).toBe('PROVIDER_FAILED: Corrupt audio');
    expect(existsSync(filePath)).toBe(false);
    cleanup();
  });

  it('keeps the audio for the retry after a first outage', async () => {
    const transcribe = jest.fn(async () => {
      throw new ProviderError(ProviderKind.deepgram, 503, 'Service unavailable');
    });
    const { worker, job, filePath, cleanup } = build(transcribe);

    const error = await worker.process(job(0)).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect((error as Error).message).toBe('PROVIDER_FAILED: Service unavailable');
    expect(existsSync(filePath)).toBe(true);
    cleanup();
  });

  it('deletes the audio after the last attempt fails, hiding network internals', async () => {
    const transcribe = jest.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const { worker, job, filePath, cleanup } = build(transcribe);

    const error = await worker.process(job(1)).catch((e: unknown) => e);
    expect((error as Error).message).toBe('PROVIDER_FAILED: The caption provider could not be reached.');
    expect(existsSync(filePath)).toBe(false);
    cleanup();
  });

  it('never writes the key to the log, even when an error message carries it', async () => {
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

  it('fails for good with CAPTIONS_UNAVAILABLE when no provider is active at run time', async () => {
    const { worker, job, filePath, cleanup } = build(null);

    const error = await worker.process(job()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect((error as Error).message).toMatch(/^CAPTIONS_UNAVAILABLE: /);
    expect(existsSync(filePath)).toBe(false);
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
