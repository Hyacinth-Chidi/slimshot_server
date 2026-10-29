import { BackupScheduler } from './backup-scheduler';

function build(availability: 'ready' | 'no-bucket' | 'not-production', queueOverrides: Record<string, jest.Mock> = {}) {
  const backups = {
    availability: jest.fn(() => availability),
    removeLeftovers: jest.fn(async () => undefined),
  };
  const queue = {
    upsertJobScheduler: jest.fn(async (..._args: unknown[]) => ({})),
    removeJobScheduler: jest.fn(async (_id: string) => true),
    ...queueOverrides,
  };
  return { scheduler: new BackupScheduler(backups as never, queue as never), backups, queue };
}

describe('BackupScheduler', () => {
  it('schedules the daily check at 03:15 UTC when ready, and removes it when not', async () => {
    const ready = build('ready');
    await ready.scheduler.sync();
    expect(ready.queue.upsertJobScheduler).toHaveBeenCalledWith(
      'backup-daily-check',
      { pattern: '15 3 * * *', tz: 'UTC' },
      { name: 'check', opts: { removeOnComplete: true, removeOnFail: true } },
    );
    expect(ready.queue.removeJobScheduler).not.toHaveBeenCalled();

    for (const reason of ['no-bucket', 'not-production'] as const) {
      const off = build(reason);
      await off.scheduler.sync();
      expect(off.queue.removeJobScheduler).toHaveBeenCalledWith('backup-daily-check');
      expect(off.queue.upsertJobScheduler).not.toHaveBeenCalled();
    }
  });

  it('clears dumps a crash left behind, whether or not backups are set up', async () => {
    for (const reason of ['ready', 'not-production'] as const) {
      const { scheduler, backups } = build(reason);
      await scheduler.sync();
      expect(backups.removeLeftovers).toHaveBeenCalled();
    }
  });

  it('never holds up boot, and never throws, when Redis is down', async () => {
    const hung = build('ready', { upsertJobScheduler: jest.fn(() => new Promise(() => undefined)) });
    expect(hung.scheduler.onModuleInit()).toBeUndefined();

    const down = build('ready', { upsertJobScheduler: jest.fn(async () => Promise.reject(new Error('ECONNREFUSED'))) });
    await expect(down.scheduler.sync()).resolves.toBeUndefined();
  });
});
