import { StatsService } from './stats.service';

function build(opts: {
  total?: number;
  byStatus?: Array<{ status: string; _count: number }>;
  byKind?: Array<{ kind: string; _count: number }>;
  bytes?: number | null;
  failed?: number;
} = {}) {
  const prisma = {
    asset: {
      count: jest.fn(async ({ where }: { where?: Record<string, unknown> } = {}) =>
        where?.status === 'failed' ? (opts.failed ?? 0) : (opts.total ?? 0),
      ),
      groupBy: jest.fn(async ({ by }: { by: string[] }) =>
        by[0] === 'status' ? (opts.byStatus ?? []) : (opts.byKind ?? []),
      ),
    },
    assetFile: {
      aggregate: jest.fn(async () => ({ _sum: { byteSize: opts.bytes ?? null } })),
    },
    $queryRaw: jest.fn(async () => []),
  };
  // Pass-through cache: these tests are about the aggregates, not caching.
  const cache = {
    wrap: jest.fn(async (_ns: string, _k: unknown, factory: () => Promise<unknown>) =>
      factory(),
    ),
  };
  return { svc: new StatsService(prisma as never, cache as never), prisma, cache };
}

describe('StatsService.summary', () => {
  it('returns zero totals on an empty database rather than null', async () => {
    const { svc } = build({ total: 0, bytes: null, failed: 0 });
    const s = await svc.summary();

    // Postgres SUM over zero rows returns NULL. A dashboard rendering that
    // shows "NaN bytes", so the service must coerce it.
    expect(s.totalBytes).toBe(0);
    expect(s.totalAssets).toBe(0);
    expect(s.failedCount).toBe(0);
  });

  it('sums bytes when files exist', async () => {
    const { svc } = build({ total: 3, bytes: 812_340 });
    await expect(svc.summary()).resolves.toMatchObject({ totalBytes: 812_340 });
  });

  it('maps grouped counts by status', async () => {
    const { svc } = build({
      total: 5,
      byStatus: [
        { status: 'published', _count: 3 },
        { status: 'ready', _count: 2 },
      ],
    });
    const s = await svc.summary();
    expect(s.byStatus).toEqual({ published: 3, ready: 2 });
  });

  it('reports the failed count separately from the status map', async () => {
    const { svc } = build({ total: 4, failed: 2 });
    await expect(svc.summary()).resolves.toMatchObject({ failedCount: 2 });
  });

  it('routes through the cache under a stats namespace', async () => {
    const { svc, cache } = build({ total: 1 });
    await svc.summary();
    expect(cache.wrap).toHaveBeenCalledWith(
      'stats',
      expect.anything(),
      expect.any(Function),
      60,
    );
  });

  it('excludes files belonging to soft-deleted assets from totalBytes', async () => {
    const { svc, prisma } = build({ total: 1, bytes: 812_340 });
    await svc.summary();

    // Without this filter, deleting an asset never reduces reported storage and
    // the number only ever climbs. It is the most prominent figure on the
    // overview screen.
    expect(prisma.assetFile.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { asset: { deletedAt: null } },
      }),
    );
  });
});

describe('StatsService.uploadsOverTime', () => {
  it('clamps days to the allowed range', async () => {
    const { svc } = build();
    await expect(svc.uploadsOverTime(9_999)).resolves.toEqual([]);
    await expect(svc.uploadsOverTime(0)).resolves.toEqual([]);
  });

  it('buckets uploads by UTC day, not the database session timezone', async () => {
    const { svc, prisma } = build();
    await svc.uploadsOverTime(30);

    const [strings] = (prisma.$queryRaw as jest.Mock).mock.calls[0] as [string[]];
    const sql = strings.join('');
    expect(sql).toContain("AT TIME ZONE 'UTC'");
  });
});
