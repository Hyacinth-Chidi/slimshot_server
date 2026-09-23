import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../core/cache/cache.service';

export interface StatsSummary {
  totalAssets: number;
  byStatus: Record<string, number>;
  byKind: Record<string, number>;
  totalBytes: number;
  failedCount: number;
}

export interface UploadPoint {
  date: string;
  count: number;
}

const SUMMARY_TTL_SECONDS = 60;
const MIN_DAYS = 1;
const MAX_DAYS = 365;

@Injectable()
export class StatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async summary(): Promise<StatsSummary> {
    return this.cache.wrap(
      'stats',
      { view: 'summary' },
      async () => {
        const [total, statusGroups, kindGroups, bytes, failed] = await Promise.all([
          this.prisma.asset.count({ where: { deletedAt: null } }),
          this.prisma.asset.groupBy({
            by: ['status'],
            where: { deletedAt: null },
            _count: true,
          }),
          this.prisma.asset.groupBy({
            by: ['kind'],
            where: { deletedAt: null },
            _count: true,
          }),
          this.prisma.assetFile.aggregate({
            _sum: { byteSize: true },
            // Files of soft-deleted assets still occupy storage until the
            // deletion worker removes them, but they must not be reported as
            // live catalogue storage — otherwise deleting an asset never
            // reduces the number and it only ever climbs.
            where: { asset: { deletedAt: null } },
          }),
          this.prisma.asset.count({ where: { status: 'failed', deletedAt: null } }),
        ]);

        return {
          totalAssets: total,
          byStatus: toCountMap(statusGroups as never, 'status'),
          byKind: toCountMap(kindGroups as never, 'kind'),
          // Postgres SUM over zero rows is NULL, not 0. Rendering that gives
          // "NaN" in the dashboard, so coerce at the boundary.
          totalBytes: (bytes as { _sum: { byteSize: number | null } })._sum.byteSize ?? 0,
          failedCount: failed,
        };
      },
      SUMMARY_TTL_SECONDS,
    );
  }

  async uploadsOverTime(days: number): Promise<UploadPoint[]> {
    if (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS) return [];

    return this.cache.wrap(
      'stats',
      { view: 'uploads', days },
      async () => {
        // `Asset.createdAt` is TIMESTAMP(3) WITHOUT time zone and Prisma
        // already writes it in UTC, so it is bucketed directly.
        //
        // Do NOT "helpfully" add `AT TIME ZONE 'UTC'` to the column. The
        // operator is directional: applied to a tz-less timestamp it CONVERTS
        // the value to timestamptz, which then renders in the session
        // timezone — the very drift it looks like it prevents. It pins a value
        // only when the input is already timestamptz.
        //
        // NOW() *is* timestamptz, so the window boundary is the one place the
        // operator belongs: `NOW() AT TIME ZONE 'UTC'` yields a tz-less UTC
        // timestamp, keeping both sides of the comparison the same type
        // instead of letting Postgres coerce one of them by session timezone.
        const rows = (await this.prisma.$queryRaw`
          SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS date,
                 COUNT(*)::int AS count
          FROM "Asset"
          WHERE "deletedAt" IS NULL
            AND "createdAt" >= (NOW() AT TIME ZONE 'UTC') - (${days} || ' days')::interval
          GROUP BY 1
          ORDER BY 1
        `) as UploadPoint[];
        return rows;
      },
      SUMMARY_TTL_SECONDS,
    );
  }
}

function toCountMap(
  groups: Array<Record<string, unknown> & { _count: number }>,
  key: string,
): Record<string, number> {
  return Object.fromEntries(groups.map((g) => [String(g[key]), g._count]));
}
