-- Fonts as a library kind: one detail row per font face. Additive only.

-- CreateTable
CREATE TABLE "FontAsset" (
    "assetId" TEXT NOT NULL,
    "familyName" TEXT NOT NULL,
    "styleName" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "postscriptName" TEXT,
    "familyKey" TEXT NOT NULL,
    "styleKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "firstPublishedAt" TIMESTAMP(3),
    "license" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FontAsset_pkey" PRIMARY KEY ("assetId")
);

-- CreateIndex
CREATE UNIQUE INDEX "FontAsset_familyKey_styleKey_key" ON "FontAsset"("familyKey", "styleKey");

-- CreateIndex
CREATE INDEX "FontAsset_sortOrder_idx" ON "FontAsset"("sortOrder");

-- AddForeignKey
ALTER TABLE "FontAsset" ADD CONSTRAINT "FontAsset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
