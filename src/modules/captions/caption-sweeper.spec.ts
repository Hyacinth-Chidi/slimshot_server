import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CaptionSweeper } from './caption-sweeper';

const posixIt = process.platform === 'win32' ? it.skip : it;
const NOW = Date.now();
const TTL = 180;

/** Real job ids have the shape CaptionsService writes: cap_ + 32 hex. */
const id = (digit: string) => `cap_${digit.repeat(32)}`;
const GONE = id('1');
const DONE = id('2');
const FAILED = id('3');
const YOUNG = id('4');
const BACKLOG = id('5');
const RUNNING = id('6');
const RETRY = id('7');

function build(states: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sweeper-'));
  const dir = join(root, 'audio');
  const queue = {
    getJob: jest.fn(async (id: string) => (states[id] ? { getState: async () => states[id] } : undefined)),
    clean: jest.fn(async () => []),
  };
  const sweeper = new CaptionSweeper({ tmpDir: dir, resultTtlSeconds: TTL } as never, queue as never);

  const file = (name: string, ageSeconds: number) => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, 'audio');
    const when = new Date(NOW - ageSeconds * 1_000);
    utimesSync(path, when, when);
    return path;
  };

  return { sweeper, queue, dir, file, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('CaptionSweeper.sweep', () => {
  it('deletes old audio whose job is gone or finished, and keeps young audio', async () => {
    const { sweeper, file, cleanup } = build({ [DONE]: 'completed', [FAILED]: 'failed' });
    const orphan = file(`${GONE}.audio`, 600);
    const done = file(`${DONE}.audio`, 600);
    const failed = file(`${FAILED}.audio`, 600);
    const young = file(`${YOUNG}.audio`, 10);

    await sweeper.sweep(NOW);

    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(done)).toBe(false);
    expect(existsSync(failed)).toBe(false);
    expect(existsSync(young)).toBe(true);
    cleanup();
  });

  it('keeps old audio whose job is still waiting or running', async () => {
    const { sweeper, file, cleanup } = build({ [BACKLOG]: 'waiting', [RUNNING]: 'active', [RETRY]: 'delayed' });
    const paths = [BACKLOG, RUNNING, RETRY].map((jobId) => file(`${jobId}.audio`, 600));

    await sweeper.sweep(NOW);

    for (const path of paths) expect(existsSync(path)).toBe(true);
    cleanup();
  });

  it('leaves files it did not write alone, however old', async () => {
    // CAPTION_TMP_DIR may be pointed at a shared folder; only caption audio is ours to delete.
    const { sweeper, file, cleanup } = build();
    const foreign = ['notes.txt', 'backup.audio', 'cap_short.audio'].map((name) => file(name, 6_000));

    await sweeper.sweep(NOW);

    for (const path of foreign) expect(existsSync(path)).toBe(true);
    cleanup();
  });

  it('prunes finished jobs older than the TTL from the queue', async () => {
    const { sweeper, queue, cleanup } = build();
    await sweeper.sweep(NOW);
    expect(queue.clean).toHaveBeenCalledWith(TTL * 1_000, 1_000, 'completed');
    expect(queue.clean).toHaveBeenCalledWith(TTL * 1_000, 1_000, 'failed');
    cleanup();
  });

  it('survives a missing directory and a failing queue', async () => {
    const { sweeper, queue, cleanup } = build();
    queue.clean.mockRejectedValue(new Error('Redis down'));
    await expect(sweeper.sweep(NOW)).resolves.toBeUndefined();
    cleanup();
  });
});

describe('CaptionSweeper lifecycle', () => {
  posixIt('creates the directory private to the server user', async () => {
    const { sweeper, dir, cleanup } = build();
    await sweeper.onModuleInit();
    sweeper.onModuleDestroy();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    cleanup();
  });

  it('finishes booting even while Redis is unreachable', async () => {
    // BullMQ calls wait for Redis indefinitely; the API must still start listening.
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
