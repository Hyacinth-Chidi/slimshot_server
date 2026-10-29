import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(__dirname, '../../prisma/migrations/20261029130000_backup_settings/migration.sql'),
  'utf8',
);

describe('backup settings schema', () => {
  it('creates the settings table', () => {
    expect(sql).toContain('CREATE TABLE "BackupSettings"');
  });

  it('lets the database refuse an interval the dashboard does not offer', () => {
    expect(sql).toContain('CHECK ("intervalDays" IN (1, 7, 30))');
  });

  it('starts with automatic backups on, every day', () => {
    expect(sql).toMatch(
      /INSERT INTO "BackupSettings" \("id", "autoEnabled", "intervalDays", "updatedAt"\)\s+VALUES \('default', true, 1, CURRENT_TIMESTAMP\);/,
    );
  });
});
