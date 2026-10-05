-- Auto caption pricing by the second: credits per started block of seconds, with an optional minimum.
-- Additive only: existing rules and charges are untouched.

-- AlterEnum
ALTER TYPE "PricingMode" ADD VALUE 'per_second';

-- AlterTable
ALTER TABLE "PricingRule" ADD COLUMN     "blockCredits" INTEGER,
ADD COLUMN     "blockSeconds" INTEGER,
ADD COLUMN     "minCredits" INTEGER;

