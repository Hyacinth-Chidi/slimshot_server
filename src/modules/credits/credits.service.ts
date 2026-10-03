import { Injectable } from '@nestjs/common';

import { CreditFeature, CreditTxType } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { PricingService } from './pricing.service';

export interface HistoryItem {
  id: string;
  type: CreditTxType;
  amount: number;
  balanceAfter: number;
  createdAt: Date;
}

@Injectable()
export class CreditsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
  ) {}

  async quote(userId: string, feature: CreditFeature, durationSeconds: number) {
    const { credits, rule } = await this.pricing.price(feature, durationSeconds);
    const { creditBalance } = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { creditBalance: true },
    });
    return { credits, balance: creditBalance, enough: creditBalance >= credits, pricingVersion: rule.version };
  }

  async history(userId: string, cursor?: string, limit = 20): Promise<{ items: HistoryItem[]; nextCursor: string | null }> {
    const rows = await this.prisma.creditTransaction.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, type: true, amount: true, balanceAfter: true, createdAt: true },
    });
    const items = rows.slice(0, limit);
    return { items, nextCursor: rows.length > limit ? items[items.length - 1].id : null };
  }
}
