import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CreditTxType } from '../generated/prisma/enums';

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
