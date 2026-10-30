-- Daily credits: a signed-in user claims a set amount once every 24 hours.
-- Additive; switched off until the owner turns it on in Credits › Rewards.

-- AlterEnum
ALTER TYPE "CreditTxType" ADD VALUE 'daily_reward';

-- AlterTable
ALTER TABLE "CreditSettings" ADD COLUMN     "dailyRewardEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "dailyRewardCredits" INTEGER NOT NULL DEFAULT 5;
