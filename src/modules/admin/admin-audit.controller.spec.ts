import { UnprocessableEntityException } from '@nestjs/common';

import { AdminAuditController } from './admin-audit.controller';

interface FindManyArgs {
  take: number;
  orderBy: unknown;
  cursor?: { id: string };
  skip?: number;
  where: Record<string, unknown>;
}

function build(rowCount = 0) {
  const calls: FindManyArgs[] = [];
  const prisma = {
    auditLog: {
      findMany: jest.fn(async (args: FindManyArgs) => {
        calls.push(args);
        return Array.from({ length: Math.min(rowCount, args.take) }, (_, i) => ({
          id: `log-${i}`,
          createdAt: new Date(),
        }));
      }),
    },
  };

  return { ctl: new AdminAuditController(prisma as never), prisma, calls };
}

describe('AdminAuditController.list', () => {
  // A cursor is only stable over a total order. `createdAt` alone is not
  // unique - two rows written in the same millisecond, which a burst of audit
  // writes produces routinely, order arbitrarily between queries, so a page
  // boundary landing inside a tie silently skips or repeats rows.
  it('orders by createdAt AND id so the cursor sits on a total order', async () => {
    const { ctl, calls } = build();
    await ctl.list();

    expect(calls[0].orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it('clamps a negative limit to at least one row', async () => {
    const { ctl, calls } = build();
    await ctl.list(undefined, undefined, undefined, undefined, undefined, '-5');

    // Prisma rejects a negative take outright; reaching it at all is a 500
    // where the caller merely sent nonsense.
    expect(calls[0].take).toBeGreaterThanOrEqual(1);
  });

  it('caps the limit at the maximum', async () => {
    const { ctl, calls } = build();
    await ctl.list(undefined, undefined, undefined, undefined, undefined, '5000');

    expect(calls[0].take).toBeLessThanOrEqual(101);
  });

  it('rejects a non-numeric limit rather than silently defaulting', async () => {
    const { ctl } = build();
    await expect(
      ctl.list(undefined, undefined, undefined, undefined, undefined, 'abc'),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('returns no cursor when the last page is exactly full', async () => {
    // Exactly `take` rows exist in total. The old check - rows.length === take
    // - reported a cursor here, and following it yielded an empty page.
    const { ctl } = build(10);
    const out = await ctl.list(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '10',
    );

    expect(out.data).toHaveLength(10);
    expect(out.meta.nextCursor).toBeNull();
  });

  it('returns a cursor and trims the probe row when more rows exist', async () => {
    const { ctl, calls } = build(50);
    const out = await ctl.list(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '10',
    );

    // One extra row is fetched purely to learn whether a next page exists; it
    // must not be served to the caller.
    expect(calls[0].take).toBe(11);
    expect(out.data).toHaveLength(10);
    expect(out.meta.nextCursor).toBe('log-9');
  });
});
