-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('audio', 'font', 'template');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('draft', 'processing', 'ready', 'published', 'archived', 'failed');

-- CreateEnum
CREATE TYPE "Visibility" AS ENUM ('public', 'unlisted', 'private');

-- CreateEnum
CREATE TYPE "ModerationState" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "FileRole" AS ENUM ('original', 'preview', 'thumbnail', 'poster', 'waveform', 'specimen', 'font_file', 'project');

-- CreateEnum
CREATE TYPE "UploadState" AS ENUM ('pending', 'uploaded', 'finalized', 'expired', 'aborted');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('active', 'suspended', 'deleted');

-- DropTable
-- The old standalone AudioAsset table (2 June test rows, author "slimshot AI
-- generated") is replaced by the new Asset/AssetFile/AudioAsset catalog model.
-- This drop is intentional and approved; the 2 rows have been backed up
-- outside the repo. A plain ALTER TABLE cannot express this change because
-- the new AudioAsset shape adds required NOT NULL columns ("assetId",
-- "durationMs") with no default, which is not satisfiable against existing
-- rows -- so the old table is dropped and the new one created fresh.
DROP TABLE "AudioAsset";

-- DropEnum
DROP TYPE "AudioType";

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "kind" "AssetKind" NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "authorName" TEXT NOT NULL,
    "ownerId" TEXT,
    "visibility" "Visibility" NOT NULL DEFAULT 'public',
    "status" "AssetStatus" NOT NULL DEFAULT 'draft',
    "moderationState" "ModerationState" NOT NULL DEFAULT 'approved',
    "createdById" TEXT,
    "updatedById" TEXT,
    "attributes" JSONB,
    "downloadCount" INTEGER NOT NULL DEFAULT 0,
    "favoriteCount" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetFile" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "role" "FileRole" NOT NULL,
    "storageId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "deliveryUrl" TEXT,
    "mimeType" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "checksumSha256" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "durationMs" INTEGER,
    "variant" JSONB,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudioAsset" (
    "assetId" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "bpm" INTEGER,
    "musicalKey" TEXT,
    "isLoopable" BOOLEAN NOT NULL DEFAULT false,
    "sampleRate" INTEGER,
    "bitrateKbps" INTEGER,
    "channels" INTEGER,

    CONSTRAINT "AudioAsset_pkey" PRIMARY KEY ("assetId")
);

-- CreateTable
CREATE TABLE "UploadSession" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "role" "FileRole" NOT NULL,
    "storageId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "state" "UploadState" NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "declaredMime" TEXT NOT NULL,
    "declaredSize" INTEGER NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalizedAt" TIMESTAMP(3),

    CONSTRAINT "UploadSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "displayName" TEXT,
    "avatarUrl" TEXT,
    "accountStatus" "AccountStatus" NOT NULL DEFAULT 'active',
    "tier" TEXT NOT NULL DEFAULT 'free',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserEntitlement" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "UserEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Asset_kind_status_publishedAt_idx" ON "Asset"("kind", "status", "publishedAt" DESC);

-- CreateIndex
CREATE INDEX "Asset_status_deletedAt_idx" ON "Asset"("status", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_kind_slug_key" ON "Asset"("kind", "slug");

-- CreateIndex
CREATE INDEX "AssetFile_assetId_role_idx" ON "AssetFile"("assetId", "role");

-- CreateIndex
CREATE INDEX "AssetFile_checksumSha256_idx" ON "AssetFile"("checksumSha256");

-- CreateIndex
CREATE UNIQUE INDEX "AssetFile_storageId_storageKey_key" ON "AssetFile"("storageId", "storageKey");

-- CreateIndex
CREATE INDEX "UploadSession_state_expiresAt_idx" ON "UploadSession"("state", "expiresAt");

-- CreateIndex
CREATE INDEX "UploadSession_assetId_idx" ON "UploadSession"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE INDEX "UserEntitlement_userId_sku_idx" ON "UserEntitlement"("userId", "sku");

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetFile" ADD CONSTRAINT "AssetFile_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetFile" ADD CONSTRAINT "AssetFile_storageId_fkey" FOREIGN KEY ("storageId") REFERENCES "StorageProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioAsset" ADD CONSTRAINT "AudioAsset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadSession" ADD CONSTRAINT "UploadSession_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserEntitlement" ADD CONSTRAINT "UserEntitlement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
