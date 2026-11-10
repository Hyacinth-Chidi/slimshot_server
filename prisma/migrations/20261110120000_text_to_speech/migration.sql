-- Text to speech: a provider capability, a credit feature, a price by characters, and the
-- voices the owner offers. Additive only: existing rules, keys and charges are untouched.

-- AlterEnum
ALTER TYPE "ProviderCapability" ADD VALUE 'text_to_speech';

-- AlterEnum
ALTER TYPE "CreditFeature" ADD VALUE 'text_to_speech';

-- AlterEnum
ALTER TYPE "PricingMode" ADD VALUE 'per_characters';

-- AlterTable
ALTER TABLE "PricingRule" ADD COLUMN     "blockCharacters" INTEGER;

-- CreateTable
CREATE TABLE "Voice" (
    "id" TEXT NOT NULL,
    "provider" "ProviderKind" NOT NULL,
    "providerVoiceId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "sampleStorageId" TEXT,
    "sampleStorageKey" TEXT,
    "sampleUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Voice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Voice_provider_providerVoiceId_key" ON "Voice"("provider", "providerVoiceId");
