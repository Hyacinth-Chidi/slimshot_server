import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CreditTxType, PricingMode } from '../generated/prisma/enums';

const sql = readFileSync(
  join(__dirname, '../../prisma/migrations/20261003120000_accounts_and_credits/migration.sql'),
  'utf8',
);

describe('accounts and credits schema', () => {
  it('knows every ledger type', () => {
    expect(Object.values(CreditTxType)).toEqual([
      'signup_bonus',
      'referral_inviter',
      'referral_invitee',
      'rewarded_ad',
      'feature_charge',
      'feature_refund',
      'admin_adjustment',
      'account_deleted',
      'purchase',
      'daily_reward',
    ]);
  });

  it('prices captions per job, by length brackets or by the second, and voices by the characters', () => {
    expect(Object.values(PricingMode)).toEqual(['per_job', 'duration_tiers', 'per_second', 'per_characters']);
  });

  it('adds text to speech additively: enum values, one nullable column, a table of its own', () => {
    const tts = readFileSync(
      join(__dirname, '../../prisma/migrations/20261110120000_text_to_speech/migration.sql'),
      'utf8',
    );
    const statements = tts
      .split(';')
      .map((s) => s.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim())
      .filter((s) => s.length > 0);
    expect(statements).toHaveLength(6);
    expect(statements.slice(0, 3)).toEqual([
      `ALTER TYPE "ProviderCapability" ADD VALUE 'text_to_speech'`,
      `ALTER TYPE "CreditFeature" ADD VALUE 'text_to_speech'`,
      `ALTER TYPE "PricingMode" ADD VALUE 'per_characters'`,
    ]);
    // Nullable, so every existing rule stays valid as it is.
    expect(statements[3]).toBe('ALTER TABLE "PricingRule" ADD COLUMN "blockCharacters" INTEGER');
    expect(statements[4]).toMatch(/^CREATE TABLE "Voice" \(/);
    expect(statements[5]).toBe(
      'CREATE UNIQUE INDEX "Voice_provider_providerVoiceId_key" ON "Voice"("provider", "providerVoiceId")',
    );
  });

  it('adds the by-the-second mode and its three columns in its own migration', () => {
    const perSecond = readFileSync(
      join(__dirname, '../../prisma/migrations/20261005120000_pricing_per_second/migration.sql'),
      'utf8',
    );
    expect(perSecond).toContain(`ALTER TYPE "PricingMode" ADD VALUE 'per_second';`);
    for (const column of ['blockSeconds', 'blockCredits', 'minCredits']) {
      expect(perSecond).toContain(`ADD COLUMN     "${column}" INTEGER`);
    }
  });

  // Prisma's schema language cannot express these three; they live only in
  // the hand-finished migration, so regenerating it would silently drop them.
  it('stops a balance going below zero at the database', () => {
    expect(sql).toContain(
      'ALTER TABLE "User" ADD CONSTRAINT "User_creditBalance_nonnegative" CHECK ("creditBalance" >= 0);',
    );
  });

  it('allows one active pricing rule per feature', () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "PricingRule_one_active" ON "PricingRule"("feature") WHERE "isActive";',
    );
  });

  it('adds daily credits, switched off, in an additive migration', () => {
    const daily = readFileSync(
      join(__dirname, '../../prisma/migrations/20261030120000_daily_reward/migration.sql'),
      'utf8',
    );
    expect(daily).toContain(`ALTER TYPE "CreditTxType" ADD VALUE 'daily_reward';`);
    expect(daily).toContain('"dailyRewardEnabled" BOOLEAN NOT NULL DEFAULT false');
    expect(daily).toContain('"dailyRewardCredits" INTEGER NOT NULL DEFAULT 5');
    expect(daily).toContain('"dailyRewardIntervalDays" INTEGER NOT NULL DEFAULT 1');
    expect(daily).toContain('CHECK ("dailyRewardIntervalDays" IN (1, 7, 30))');
    expect(daily).not.toMatch(/DROP|DELETE|UPDATE/i);
  });

  it('creates the default settings row', () => {
    expect(sql).toMatch(/INSERT INTO "CreditSettings"[\s\S]*'default', 100, 5, 10, 20, 20, 10, 30, 10,/);
  });
});
