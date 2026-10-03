import { HttpStatus, Injectable } from '@nestjs/common';

import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { CreditFeature } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { type PricedRule, type PriceTier, priceFor } from './pricing';

@Injectable()
export class PricingService {
  constructor(private readonly prisma: PrismaService) {}

  async activeRule(feature: CreditFeature): Promise<PricedRule | null> {
    const row = await this.prisma.pricingRule.findFirst({ where: { feature, isActive: true } });
    if (!row) return null;
    return {
      id: row.id,
      version: row.version,
      mode: row.mode,
      perJobCredits: row.perJobCredits,
      tiers: (row.tiers as unknown as PriceTier[] | null) ?? null,
    };
  }

  async price(feature: CreditFeature, durationSeconds: number): Promise<{ credits: number; rule: PricedRule }> {
    const rule = await this.activeRule(feature);
    if (!rule) {
      throw appError(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.CAPTIONS_UNAVAILABLE,
        'Auto caption is not available right now. Try again later.',
      );
    }
    return { credits: priceFor(rule, durationSeconds), rule };
  }
}
