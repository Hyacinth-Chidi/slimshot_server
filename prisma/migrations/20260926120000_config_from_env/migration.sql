-- Configuration moved to environment variables (see
-- docs/superpowers/specs/2026-09-26-env-config-design.md). Run this only after
-- the new server is deployed: the old server reads both of these at boot.

-- DropTable
DROP TABLE "SystemSetting";

-- AlterTable
ALTER TABLE "StorageProvider" DROP COLUMN "configCipher",
DROP COLUMN "keyVersion";
