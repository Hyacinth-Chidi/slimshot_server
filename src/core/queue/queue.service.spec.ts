import { QueueService } from './queue.service';

function fakeQueue() {
  return {
    add: jest.fn(
      async (_name?: unknown, _data?: unknown, _opts?: unknown) => ({
        id: 'job-1',
      }),
    ),
    getWaitingCount: jest.fn(async () => 2),
    getActiveCount: jest.fn(async () => 1),
    getFailedCount: jest.fn(async () => 0),
  };
}

describe('QueueService', () => {
  it('enqueues a processing job named after the processor', async () => {
    const queue = fakeQueue();
    const svc = new QueueService(queue as never);

    await svc.enqueueAssetProcessing({ assetId: 'a1', processor: 'audio:preview' });

    expect(queue.add).toHaveBeenCalledWith(
      'audio:preview',
      { assetId: 'a1', processor: 'audio:preview' },
      expect.objectContaining({ attempts: expect.any(Number) }),
    );
  });

  it('returns the job id', async () => {
    const svc = new QueueService(fakeQueue() as never);
    await expect(
      svc.enqueueAssetProcessing({ assetId: 'a1', processor: 'audio:preview' }),
    ).resolves.toBe('job-1');
  });

  it('retries with backoff so a transient provider failure is not fatal', async () => {
    const queue = fakeQueue();
    const svc = new QueueService(queue as never);
    await svc.enqueueAssetProcessing({ assetId: 'a1', processor: 'audio:preview' });

    const opts = queue.add.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.attempts).toBeGreaterThan(1);
    expect(opts.backoff).toMatchObject({ type: 'exponential' });
  });

  it('reports queue health for the admin jobs endpoint', async () => {
    const svc = new QueueService(fakeQueue() as never);
    await expect(svc.getQueueHealth()).resolves.toEqual({
      waiting: 2,
      active: 1,
      failed: 0,
    });
  });
});
