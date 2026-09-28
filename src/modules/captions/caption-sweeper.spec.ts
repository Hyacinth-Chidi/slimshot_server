import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CaptionSweeper } from './caption-sweeper';

const posixIt = process.platform === 'win32' ? it.skip : it;
const NOW = Date.now();
const TTL = 180;

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
    const { sweeper, file, cleanup } = build({ cap_done: 'completed', cap_failed: 'failed' });
    const orphan = file('cap_gone.audio', 600);
    const done = file('cap_done.audio', 600);
    const failed = file('cap_failed.audio', 600);
    const young = file('cap_young.audio', 10);

    await sweeper.sweep(NOW);

    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(done)).toBe(false);
    expect(existsSync(failed)).toBe(false);
    expect(existsSync(young)).toBe(true);
    cleanup();
  });

  it('keeps old audio whose job is still waiting or running', async () => {
    const { sweeper, file, cleanup } = build({ cap_backlog: 'waiting', cap_running: 'active', cap_retry: 'delayed' });
    const paths = ['cap_backlog', 'cap_running', 'cap_retry'].map((id) => file(`${id}.audio`, 600));

    await sweeper.sweep(NOW);

    for (const path of paths) expect(existsSync(path)).toBe(true);
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

  it('creates the directory on boot', async () => {
    const { sweeper, dir, cleanup } = build();
    await sweeper.onModuleInit();
    sweeper.onModuleDestroy();
    expect(existsSync(dir)).toBe(true);
    cleanup();
  });
});
