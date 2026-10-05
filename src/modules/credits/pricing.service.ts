import { HttpStatus, Injectable } from '@nestjs/common';

import { AuditService } from '../../core/audit/audit.service';
import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { isUniqueViolation } from '../../core/errors/prisma-errors';
import type { Prisma, PricingRule } from '../../generated/prisma/client';
import { CreditFeature, PricingMode } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { blockProblems, type PricedRule, type PriceTier, priceFor, tierProblems } from './pricing';

export interface NewPricingRule {
  feature: CreditFeature;
  mode: PricingMode;
  perJobCredits?: number;
  tiers?: PriceTier[];
  blockSeconds?: number;
  blockCredits?: number;
  minCredits?: number;
  note?: string;
}

function ruleProblems(input: NewPricingRule): string[] {
  if (input.mode === PricingMode.duration_tiers) return tierProblems(input.tiers ?? []);
  if (input.mode === PricingMode.per_second) return blockProblems(input);
  const credits = input.perJobCredits;
  return credits === undefined || !Number.isInteger(credits) || credits < 0
    ? ['A per-job rule needs perJobCredits, a whole number ≥ 0.']
    : [];
}

@Injectable()
export class PricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async activeRule(feature: CreditFeature): Promise<PricedRule | null> {
    const row = await this.prisma.pricingRule.findFirst({ where: { feature, isActive: true } });
    if (!row) return null;
    return {
      id: row.id,
      version: row.version,
      mode: row.mode,
      perJobCredits: row.perJobCredits,
      tiers: (row.tiers as unknown as PriceTier[] | null) ?? null,
      blockSeconds: row.blockSeconds,
      blockCredits: row.blockCredits,
      minCredits: row.minCredits,
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

  /** Every version of a feature's pricing, newest first. */
  listRules(feature: CreditFeature): Promise<PricingRule[]> {
    return this.prisma.pricingRule.findMany({ where: { feature }, orderBy: { version: 'desc' } });
  }

  /** A new, inactive version. Rules are never edited: a price change is a new version. */
  async createRule(input: NewPricingRule, adminId: string): Promise<PricingRule> {
    const problems = ruleProblems(input);
    if (problems.length > 0) {
      throw appError(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.VALIDATION_FAILED, 'The pricing rule is not valid.', {
        problems,
      });
    }
    const tiered = input.mode === PricingMode.duration_tiers;
    const perSecond = input.mode === PricingMode.per_second;
    const last = await this.prisma.pricingRule.findFirst({
      where: { feature: input.feature },
      orderBy: { version: 'desc' },
    });
    let created: PricingRule;
    try {
      created = await this.prisma.pricingRule.create({
        data: {
          feature: input.feature,
          version: (last?.version ?? 0) + 1,
          mode: input.mode,
          // Each mode stores only its own fields, so a row never carries a stray price.
          perJobCredits: input.mode === PricingMode.per_job ? input.perJobCredits : null,
          ...(tiered ? { tiers: input.tiers as unknown as Prisma.InputJsonValue } : {}),
          blockSeconds: perSecond ? input.blockSeconds : null,
          blockCredits: perSecond ? input.blockCredits : null,
          minCredits: perSecond ? (input.minCredits ?? null) : null,
          note: input.note,
          createdById: adminId,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw this.concurrentChange();
      throw error;
    }
    await this.audit.record({
      actorId: adminId,
      actorType: 'admin',
      action: 'pricing.rule.created',
      entityType: 'PricingRule',
      entityId: created.id,
      after: created,
    });
    return created;
  }

  /** Makes this version the one that prices jobs, switching the previous one off. */
  async activate(id: string, adminId: string): Promise<PricingRule[]> {
    const rule = await this.prisma.pricingRule.findUnique({ where: { id } });
    if (!rule) throw appError(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'Pricing rule not found.');
    if (!rule.isActive) {
      try {
        await this.prisma.$transaction([
          this.prisma.pricingRule.updateMany({
            where: { feature: rule.feature, isActive: true },
            data: { isActive: false },
          }),
          this.prisma.pricingRule.update({ where: { id }, data: { isActive: true, activatedAt: new Date() } }),
        ]);
      } catch (error) {
        // The partial unique index allows one active rule per feature; a racing activation lost.
        if (isUniqueViolation(error)) throw this.concurrentChange();
        throw error;
      }
      await this.audit.record({
        actorId: adminId,
        actorType: 'admin',
        action: 'pricing.rule.activated',
        entityType: 'PricingRule',
        entityId: id,
        after: { feature: rule.feature, version: rule.version },
      });
    }
    return this.listRules(rule.feature);
  }

  private concurrentChange() {
    return appError(
      HttpStatus.CONFLICT,
      ErrorCode.CONFLICT,
      'Pricing changed at the same time from somewhere else. Reload and try again.',
    );
  }
}
