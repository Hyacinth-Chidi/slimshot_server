import { CreditTxType } from '../../generated/prisma/enums';

const DAY_MS = 86_400_000;

/** Ad caps reset at UTC midnight for everyone. */
export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function nextUtcMidnight(now: Date): Date {
  return new Date(startOfUtcDay(now).getTime() + DAY_MS);
}

interface CountsTransactions {
  creditTransaction: { count(args: { where: Record<string, unknown> }): Promise<number> };
}

export function adsUsedToday(db: CountsTransactions, userId: string, now = new Date()): Promise<number> {
  return db.creditTransaction.count({
    where: { userId, type: CreditTxType.rewarded_ad, createdAt: { gte: startOfUtcDay(now) } },
  });
}
