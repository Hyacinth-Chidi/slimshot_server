import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { AuditService } from '../../core/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';

export interface BalanceMismatch {
  userId: string;
  cached: number;
  ledger: number;
}

const FIRST_RUN_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

/** Daily proof that every cached balance equals its ledger sum. Reports; never corrects. */
@Injectable()
export class ReconciliationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconciliationService.name);
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    const first = setTimeout(() => void this.run(), FIRST_RUN_MS);
    const daily = setInterval(() => void this.run(), DAY_MS);
    first.unref();
    daily.unref();
    this.timers = [first, daily];
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) clearTimeout(timer);
  }

  async check(): Promise<BalanceMismatch[]> {
    const rows = await this.prisma.$queryRaw<Array<{ userId: string; cached: number; ledger: number }>>`
      SELECT u."id" AS "userId", u."creditBalance" AS "cached", COALESCE(SUM(t."amount"), 0)::int AS "ledger"
      FROM "User" u
      LEFT JOIN "CreditTransaction" t ON t."userId" = u."id"
      GROUP BY u."id", u."creditBalance"
      HAVING u."creditBalance" <> COALESCE(SUM(t."amount"), 0)`;
    return rows.map((r) => ({ userId: r.userId, cached: Number(r.cached), ledger: Number(r.ledger) }));
  }

  async run(): Promise<BalanceMismatch[]> {
    try {
      const mismatches = await this.check();
      for (const m of mismatches) {
        this.logger.error(`Credit balance mismatch for user ${m.userId}: cached ${m.cached}, ledger ${m.ledger}`);
        await this.audit.record({
          actorType: 'system',
          action: 'credits.reconcile.mismatch',
          entityType: 'User',
          entityId: m.userId,
          after: { cached: m.cached, ledger: m.ledger },
        });
      }
      return mismatches;
    } catch (err) {
      this.logger.warn(`Credit balance check failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }
}
