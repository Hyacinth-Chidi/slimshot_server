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
  /** per_second only: credits per started block of `blockSeconds`, never below `minCredits`. */
  blockSeconds?: number | null;
  blockCredits?: number | null;
  minCredits?: number | null;
}

export interface BlockRate {
  blockSeconds?: number | null;
  blockCredits?: number | null;
  minCredits?: number | null;
}

export const MAX_BLOCK_SECONDS = 86_400;

/**
 * Credits for a duration. Tier boundaries are inclusive: exactly 60 s is "up to 60".
 * By the second, a started block counts in full; the duration is first rounded to
 * the millisecond so floating-point noise from the WAV maths never starts a block.
 */
export function priceFor(rule: PricedRule, durationSeconds: number): number {
  if (rule.mode === PricingMode.per_job) return rule.perJobCredits ?? 0;
  if (rule.mode === PricingMode.per_second) {
    const blockMs = (rule.blockSeconds ?? 0) * 1000;
    if (blockMs <= 0) throw new Error(`Pricing rule ${rule.id} has no block length.`);
    const blocks = Math.max(1, Math.ceil(Math.round(durationSeconds * 1000) / blockMs));
    return Math.max(rule.minCredits ?? 0, blocks * (rule.blockCredits ?? 0));
  }
  const tier = (rule.tiers ?? []).find((t) => t.upToSeconds === null || durationSeconds <= t.upToSeconds);
  if (!tier) throw new Error(`Pricing rule ${rule.id} has no tier for ${durationSeconds} s.`);
  return tier.credits;
}

/** What is wrong with a by-the-second rate (empty when valid). */
export function blockProblems(rate: BlockRate): string[] {
  const problems: string[] = [];
  const { blockSeconds, blockCredits, minCredits } = rate;
  if (
    blockSeconds === undefined ||
    blockSeconds === null ||
    !Number.isInteger(blockSeconds) ||
    blockSeconds < 1 ||
    blockSeconds > MAX_BLOCK_SECONDS
  ) {
    problems.push(`blockSeconds must be a whole number from 1 to ${MAX_BLOCK_SECONDS}.`);
  }
  if (blockCredits === undefined || blockCredits === null || !Number.isInteger(blockCredits) || blockCredits < 0) {
    problems.push('blockCredits must be a whole number ≥ 0.');
  }
  if (minCredits !== undefined && minCredits !== null && (!Number.isInteger(minCredits) || minCredits < 0)) {
    problems.push('minCredits must be a whole number ≥ 0.');
  }
  return problems;
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
