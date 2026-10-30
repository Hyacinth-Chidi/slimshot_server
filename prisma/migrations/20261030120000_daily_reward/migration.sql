-- Credit claims: a signed-in user claims a set amount once every 1, 7 or 30 days.
-- Additive; switched off until the owner turns it on in Credits › Rewards.

-- AlterEnum
ALTER TYPE "CreditTxType" ADD VALUE 'daily_reward';

-- AlterTable
ALTER TABLE "CreditSettings" ADD COLUMN     "dailyRewardEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "dailyRewardCredits" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "dailyRewardIntervalDays" INTEGER NOT NULL DEFAULT 1;

-- The dashboard offers every day, every week and every month (30 days); nothing else.
ALTER TABLE "CreditSettings" ADD CONSTRAINT "CreditSettings_dailyRewardIntervalDays_allowed" CHECK ("dailyRewardIntervalDays" IN (1, 7, 30));
