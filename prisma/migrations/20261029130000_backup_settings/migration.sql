-- Database backups. See docs/superpowers/specs/2026-10-29-database-backups-design.md.

-- CreateTable
CREATE TABLE "BackupSettings" (
    "id" TEXT NOT NULL,
    "autoEnabled" BOOLEAN NOT NULL DEFAULT true,
    "intervalDays" INTEGER NOT NULL DEFAULT 1,
    "lastRunAt" TIMESTAMP(3),
    "lastRunOk" BOOLEAN,
    "lastRunError" TEXT,
    "lastRunTrigger" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackupSettings_pkey" PRIMARY KEY ("id")
);

-- The dashboard offers every day, every 7 days and every 30 days; nothing else.
ALTER TABLE "BackupSettings" ADD CONSTRAINT "BackupSettings_intervalDays_allowed" CHECK ("intervalDays" IN (1, 7, 30));

-- Automatic backups start on, every day; the owner can change both from the dashboard.
INSERT INTO "BackupSettings" ("id", "autoEnabled", "intervalDays", "updatedAt")
VALUES ('default', true, 1, CURRENT_TIMESTAMP);
