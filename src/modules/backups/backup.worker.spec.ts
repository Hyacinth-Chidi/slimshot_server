import type { Job } from 'bullmq';

import { BackupWorker } from './backup.worker';

function build() {
  const backups = {
    runScheduledCheck: jest.fn(async () => 'not-due'),
    runBackup: jest.fn(async () => ({ filename: 'slimshot-20261029-031507-manual.dump' })),
  };
  return { worker: new BackupWorker(backups as never), backups };
}

const job = (name: string, data?: unknown) => ({ name, data }) as unknown as Job;

describe('BackupWorker', () => {
  it('runs the daily check for a check job', async () => {
    const { worker, backups } = build();
    expect(await worker.process(job('check'))).toBe('not-due');
    expect(backups.runBackup).not.toHaveBeenCalled();
  });

  it('makes the backup a run job asks for', async () => {
    const { worker, backups } = build();
    const actor = { id: 'admin-1', email: 'owner@example.com' };
    expect(await worker.process(job('run', { trigger: 'manual', actor }))).toBe('slimshot-20261029-031507-manual.dump');
    expect(backups.runBackup).toHaveBeenCalledWith('manual', actor);
  });

  it('fails a job it does not know', async () => {
    const { worker } = build();
    await expect(worker.process(job('cleanup'))).rejects.toThrow('Unknown backup job "cleanup"');
  });
});
