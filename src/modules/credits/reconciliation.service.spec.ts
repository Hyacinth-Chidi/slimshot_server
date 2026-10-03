import { Logger } from '@nestjs/common';

import { ReconciliationService } from './reconciliation.service';

function build(rows: unknown[] | Error) {
  const prisma = {
    $queryRaw: jest.fn(async () => {
      if (rows instanceof Error) throw rows;
      return rows;
    }),
  };
  const audit = { record: jest.fn(async (_e: unknown) => undefined) };
  return { audit, svc: new ReconciliationService(prisma as never, audit as never) };
}

describe('ReconciliationService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reports users whose cached balance differs from the ledger sum', async () => {
    const { svc } = build([{ userId: 'u1', cached: 50, ledger: 45 }]);
    await expect(svc.check()).resolves.toEqual([{ userId: 'u1', cached: 50, ledger: 45 }]);
  });

  it('logs and audits each mismatch', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { svc, audit } = build([{ userId: 'u1', cached: 50, ledger: 45 }]);
    await svc.run();
    expect(error).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'credits.reconcile.mismatch',
        entityId: 'u1',
        after: { cached: 50, ledger: 45 },
      }),
    );
  });

  it('survives a database error', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(build(new Error('db down')).svc.run()).resolves.toEqual([]);
  });

  it('schedules itself without keeping the process alive', () => {
    const { svc } = build([]);
    svc.onModuleInit();
    svc.onModuleDestroy();
  });
});
