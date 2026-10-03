import { PricingMode } from '../../generated/prisma/enums';

export interface PriceTier {
  upToSeconds: number | null;
  credits: number;
}

export interface PricedRule {
  id: string;
  version: number;
  mode: PricingMode;
  perJobCredits: number | null;
  tiers: PriceTier[] | null;
}

/** Credits for a duration. Tier boundaries are inclusive: exactly 60 s is "up to 60". */
export function priceFor(rule: PricedRule, durationSeconds: number): number {
  if (rule.mode === PricingMode.per_job) return rule.perJobCredits ?? 0;
  const tier = (rule.tiers ?? []).find((t) => t.upToSeconds === null || durationSeconds <= t.upToSeconds);
  if (!tier) throw new Error(`Pricing rule ${rule.id} has no tier for ${durationSeconds} s.`);
  return tier.credits;
}

/** What is wrong with a tier list (empty when valid). */
export function tierProblems(tiers: PriceTier[]): string[] {
  const problems: string[] = [];
  if (tiers.length === 0) problems.push('At least one tier is required.');
  tiers.forEach((tier, i) => {
    const n = i + 1;
    const last = i === tiers.length - 1;
    if (!Number.isInteger(tier.credits) || tier.credits < 0) {
      problems.push(`Tier ${n}: credits must be a whole number ≥ 0.`);
    }
    if (last && tier.upToSeconds !== null) problems.push('The last tier must be open-ended (upToSeconds: null).');
    if (!last && tier.upToSeconds === null) problems.push(`Tier ${n}: only the last tier can be open-ended.`);
    if (tier.upToSeconds !== null && (!Number.isInteger(tier.upToSeconds) || tier.upToSeconds <= 0)) {
      problems.push(`Tier ${n}: upToSeconds must be a whole number > 0.`);
    }
    const previous = i > 0 ? tiers[i - 1].upToSeconds : null;
    if (tier.upToSeconds !== null && previous !== null && tier.upToSeconds <= previous) {
      problems.push(`Tier ${n}: upToSeconds must be greater than the tier before.`);
    }
  });
  return problems;
}
