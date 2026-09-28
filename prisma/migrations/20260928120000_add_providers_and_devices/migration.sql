-- Auto caption: provider API keys (encrypted) and anonymous app devices.
-- See docs/superpowers/specs/2026-09-27-auto-caption-design.md.

-- CreateEnum
CREATE TYPE "ProviderKind" AS ENUM ('deepgram', 'elevenlabs');

-- CreateEnum
CREATE TYPE "ProviderCapability" AS ENUM ('speech_to_text');

-- CreateTable
CREATE TABLE "ProviderCredential" (
    "id" TEXT NOT NULL,
    "provider" "ProviderKind" NOT NULL,
    "capability" "ProviderCapability" NOT NULL,
    "apiKeyCipher" BYTEA NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "platform" TEXT,
    "appVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProviderCredential_provider_capability_key" ON "ProviderCredential"("provider", "capability");

-- CreateIndex
CREATE UNIQUE INDEX "Device_tokenHash_key" ON "Device"("tokenHash");


-- At most one active provider per capability, enforced by the database itself.
CREATE UNIQUE INDEX "ProviderCredential_one_active" ON "ProviderCredential"("capability") WHERE "isActive";
