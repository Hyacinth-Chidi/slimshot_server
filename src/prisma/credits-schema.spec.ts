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
    ]);
  });

  it('prices captions per job, by length brackets, or by the second', () => {
    expect(Object.values(PricingMode)).toEqual(['per_job', 'duration_tiers', 'per_second']);
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

  it('creates the default settings row', () => {
    expect(sql).toMatch(/INSERT INTO "CreditSettings"[\s\S]*'default', 100, 5, 10, 20, 20, 10, 30, 10,/);
  });
});
