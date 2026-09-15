◇ injected env (7) from .env // tip: ⌘ override existing { override: true }
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AudioType" AS ENUM ('music', 'sfx');

-- CreateTable
CREATE TABLE "AudioAsset" (
    "id" TEXT NOT NULL,
    "cloudinaryAssetId" TEXT,
    "cloudinaryPublicId" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "previewUrl" TEXT NOT NULL,
    "downloadUrl" TEXT NOT NULL,
    "type" "AudioType" NOT NULL,
    "tags" TEXT[],
    "mimeType" TEXT NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AudioAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AudioAsset_cloudinaryAssetId_key" ON "AudioAsset"("cloudinaryAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "AudioAsset_cloudinaryPublicId_key" ON "AudioAsset"("cloudinaryPublicId");

-- CreateIndex
CREATE INDEX "AudioAsset_type_uploadedAt_idx" ON "AudioAsset"("type", "uploadedAt" DESC);

-- CreateIndex
CREATE INDEX "AudioAsset_title_idx" ON "AudioAsset"("title");

-- CreateIndex
CREATE INDEX "AudioAsset_author_idx" ON "AudioAsset"("author");

