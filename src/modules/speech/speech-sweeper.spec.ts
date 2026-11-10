import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SpeechSweeper } from './speech-sweeper';

const posixIt = process.platform === 'win32' ? it.skip : it;
const NOW = Date.now();
const KEEP_MINUTES = 60;
const OLD = 61 * 60;
const YOUNG_AGE = 10 * 60;

/** Real job ids have the shape SpeechService makes: tts_ + 32 hex. */
const id = (digit: string) => `tts_${digit.repeat(32)}`;

interface FakeJob {
  state: string;
  /** Seconds ago. */
  finishedAgo?: number;
}

function build(jobs: Record<string, FakeJob> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'speech-sweeper-'));
  const dir = join(root, 'speech');
  const queue = {
    getJob: jest.fn(async (jobId: string) => {
      const job = jobs[jobId];
      if (!job) return undefined;
      return {
        getState: async () => job.state,
        finishedOn: job.finishedAgo === undefined ? undefined : NOW - job.finishedAgo * 1_000,
      };
    }),
    clean: jest.fn(async () => []),
  };
  const sweeper = new SpeechSweeper({ tmpDir: dir, keepMinutes: KEEP_MINUTES } as never, queue as never);

  /** A job's folder holding one voice, last written `ageSeconds` ago. */
  const jobFolder = (name: string, ageSeconds: number) => {
    const path = join(dir, name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'a.mp3'), 'mp3');
    const when = new Date(NOW - ageSeconds * 1_000);
    utimesSync(path, when, when);
    return path;
  };

  return { sweeper, queue, dir, jobFolder, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('SpeechSweeper.sweep', () => {
  it("deletes a job's files once it is TTS_KEEP_MINUTES old", async () => {
    const done = id('1');
    const failed = id('2');
    const fresh = id('3');
    const gone = id('4');
    const goneYoung = id('5');
    const { sweeper, jobFolder, cleanup } = build({
      [done]: { state: 'completed', finishedAgo: OLD },
      [failed]: { state: 'failed', finishedAgo: OLD },
      // Finished a moment ago, though its folder was made long before: the app still has its hour.
      [fresh]: { state: 'completed', finishedAgo: YOUNG_AGE },
    });
    const paths = {
      done: jobFolder(done, OLD),
      failed: jobFolder(failed, OLD),
      fresh: jobFolder(fresh, OLD),
      gone: jobFolder(gone, OLD),
      goneYoung: jobFolder(goneYoung, YOUNG_AGE),
    };

    await sweeper.sweep(NOW);

    expect(existsSync(paths.done)).toBe(false);
    expect(existsSync(paths.failed)).toBe(false);
    expect(existsSync(paths.gone)).toBe(false);
    expect(existsSync(paths.fresh)).toBe(true);
    expect(existsSync(paths.goneYoung)).toBe(true);
    cleanup();
  });

  it('keeps the files of a job still waiting or running, however old', async () => {
    const waiting = id('6');
    const running = id('7');
    const retrying = id('8');
    const { sweeper, jobFolder, cleanup } = build({
      [waiting]: { state: 'waiting' },
      [running]: { state: 'active' },
      [retrying]: { state: 'delayed' },
    });
    const paths = [waiting, running, retrying].map((jobId) => jobFolder(jobId, OLD));

    await sweeper.sweep(NOW);

    for (const path of paths) expect(existsSync(path)).toBe(true);
    cleanup();
  });

  it("leaves what is not a speech job's", async () => {
    // TTS_TMP_DIR may be pointed at a shared folder; only tts_ job folders are ours to delete.
    const { sweeper, dir, jobFolder, cleanup } = build();
    const foreign = ['notes', 'tts_short', `cap_${'1'.repeat(32)}`].map((name) => jobFolder(name, 6_000));
    const looseFile = join(dir, `${id('9')}.mp3`);
    writeFileSync(looseFile, 'mp3');
    const when = new Date(NOW - 6_000 * 1_000);
    utimesSync(looseFile, when, when);

    await sweeper.sweep(NOW);

    for (const path of foreign) expect(existsSync(path)).toBe(true);
    expect(existsSync(looseFile)).toBe(true);
    cleanup();
  });

  it('prunes finished jobs past the window from the queue', async () => {
    const { sweeper, queue, cleanup } = build();
    await sweeper.sweep(NOW);
    expect(queue.clean).toHaveBeenCalledWith(KEEP_MINUTES * 60_000, 1_000, 'completed');
    expect(queue.clean).toHaveBeenCalledWith(KEEP_MINUTES * 60_000, 1_000, 'failed');
    cleanup();
  });

  it('survives a missing directory and a failing queue', async () => {
    const { sweeper, queue, cleanup } = build();
    queue.clean.mockRejectedValue(new Error('Redis down'));
    await expect(sweeper.sweep(NOW)).resolves.toBeUndefined();
    cleanup();
  });
});

describe('SpeechSweeper lifecycle', () => {
  posixIt('creates the directory private to the server user', async () => {
    const { sweeper, dir, cleanup } = build();
    await sweeper.onModuleInit();
    sweeper.onModuleDestroy();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    cleanup();
  });

  it('finishes booting even while Redis is unreachable', async () => {
    const { sweeper, queue, cleanup } = build();
    queue.clean.mockImplementation(() => new Promise<never[]>(() => undefined));

    const outcome = await Promise.race([
      sweeper.onModuleInit().then(() => 'booted'),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 500)),
    ]);
    sweeper.onModuleDestroy();

    expect(outcome).toBe('booted');
    cleanup();
  });

  it('creates the directory on boot', async () => {
    const { sweeper, dir, cleanup } = build();
    await sweeper.onModuleInit();
    sweeper.onModuleDestroy();
    expect(existsSync(dir)).toBe(true);
    cleanup();
  });
});
