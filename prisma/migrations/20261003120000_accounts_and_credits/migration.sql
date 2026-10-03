-- Accounts and credits. See docs/superpowers/specs/2026-10-03-accounts-and-credits-design.md.

-- CreateEnum
CREATE TYPE "CreditTxType" AS ENUM ('signup_bonus', 'referral_inviter', 'referral_invitee', 'rewarded_ad', 'feature_charge', 'feature_refund', 'admin_adjustment', 'account_deleted', 'purchase');

-- CreateEnum
CREATE TYPE "CreditFeature" AS ENUM ('auto_captions');

-- CreateEnum
CREATE TYPE "PricingMode" AS ENUM ('per_job', 'duration_tiers');

-- CreateEnum
CREATE TYPE "BonusClaimKind" AS ENUM ('email', 'install');

-- CreateEnum
CREATE TYPE "ReferralOutcome" AS ENUM ('rewarded', 'invitee_ineligible', 'inviter_capped');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "creditBalance" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "googleSub" TEXT,
ADD COLUMN     "referralCode" TEXT,
ADD COLUMN     "signupIpLimited" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "username" TEXT;

-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "userId" TEXT;

-- CreateTable
CREATE TABLE "UserSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "UserSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRefreshToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserRefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditTransaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "CreditTxType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "reference" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BonusClaim" (
    "id" TEXT NOT NULL,
    "kind" "BonusClaimKind" NOT NULL,
    "hmac" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BonusClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Referral" (
    "id" TEXT NOT NULL,
    "inviterId" TEXT NOT NULL,
    "inviteeId" TEXT NOT NULL,
    "outcome" "ReferralOutcome" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditSettings" (
    "id" TEXT NOT NULL,
    "signupBonusCredits" INTEGER NOT NULL,
    "adRewardCredits" INTEGER NOT NULL,
    "adDailyCap" INTEGER NOT NULL,
    "referralInviterCredits" INTEGER NOT NULL,
    "referralInviteeCredits" INTEGER NOT NULL,
    "referralCapCount" INTEGER NOT NULL,
    "referralCapDays" INTEGER NOT NULL,
    "ipSignupLimitPer24h" INTEGER NOT NULL,
    "disposableEmailDomains" TEXT[],
    "otpMaxAttempts" INTEGER NOT NULL,
    "otpResendCooldownSeconds" INTEGER NOT NULL,
    "otpPerEmailPerHour" INTEGER NOT NULL,
    "otpPerDevicePerHour" INTEGER NOT NULL,
    "otpPerIpPerHour" INTEGER NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingRule" (
    "id" TEXT NOT NULL,
    "feature" "CreditFeature" NOT NULL,
    "version" INTEGER NOT NULL,
    "mode" "PricingMode" NOT NULL,
    "perJobCredits" INTEGER,
    "tiers" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),

    CONSTRAINT "PricingRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserSession_userId_revokedAt_idx" ON "UserSession"("userId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserRefreshToken_tokenHash_key" ON "UserRefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "UserRefreshToken_sessionId_idx" ON "UserRefreshToken"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditTransaction_idempotencyKey_key" ON "CreditTransaction"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CreditTransaction_userId_createdAt_idx" ON "CreditTransaction"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CreditTransaction_type_createdAt_idx" ON "CreditTransaction"("type", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BonusClaim_kind_hmac_key" ON "BonusClaim"("kind", "hmac");

-- CreateIndex
CREATE UNIQUE INDEX "Referral_inviteeId_key" ON "Referral"("inviteeId");

-- CreateIndex
CREATE INDEX "Referral_inviterId_createdAt_idx" ON "Referral"("inviterId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PricingRule_feature_version_key" ON "PricingRule"("feature", "version");

-- CreateIndex
CREATE UNIQUE INDEX "User_googleSub_key" ON "User"("googleSub");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_referralCode_key" ON "User"("referralCode");

-- CreateIndex
CREATE INDEX "Device_userId_idx" ON "Device"("userId");

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRefreshToken" ADD CONSTRAINT "UserRefreshToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "UserSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_inviteeId_fkey" FOREIGN KEY ("inviteeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A balance can never go below zero, whatever the application does.
ALTER TABLE "User" ADD CONSTRAINT "User_creditBalance_nonnegative" CHECK ("creditBalance" >= 0);

-- At most one active pricing rule per feature.
CREATE UNIQUE INDEX "PricingRule_one_active" ON "PricingRule"("feature") WHERE "isActive";

-- Default credit settings; every value is editable from the admin API.
INSERT INTO "CreditSettings" ("id", "signupBonusCredits", "adRewardCredits", "adDailyCap", "referralInviterCredits", "referralInviteeCredits", "referralCapCount", "referralCapDays", "ipSignupLimitPer24h", "disposableEmailDomains", "otpMaxAttempts", "otpResendCooldownSeconds", "otpPerEmailPerHour", "otpPerDevicePerHour", "otpPerIpPerHour", "updatedAt")
VALUES ('default', 100, 5, 10, 20, 20, 10, 30, 10, ARRAY['10minutemail.com', 'discard.email', 'dispostable.com', 'emailondeck.com', 'fakeinbox.com', 'getnada.com', 'guerrillamail.com', 'guerrillamail.net', 'maildrop.cc', 'mailinator.com', 'mailnesia.com', 'mintemail.com', 'moakt.com', 'mohmal.com', 'sharklasers.com', 'temp-mail.org', 'tempmail.com', 'throwawaymail.com', 'trashmail.com', 'yopmail.com'], 5, 60, 5, 10, 20, CURRENT_TIMESTAMP);
