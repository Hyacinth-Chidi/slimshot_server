import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(join(__dirname, '../../prisma/migrations/20261030130000_push_notifications/migration.sql'), 'utf8');

describe('push notifications schema', () => {
  it('gives each install at most one push token, held by one install only', () => {
    expect(sql).toContain('ALTER TABLE "Device" ADD COLUMN     "pushToken" TEXT');
    expect(sql).toContain('CREATE UNIQUE INDEX "Device_pushToken_key" ON "Device"("pushToken");');
  });

  it('keeps a history of what was sent', () => {
    expect(sql).toContain('CREATE TABLE "PushMessage"');
  });

  it('is additive', () => {
    expect(sql).not.toMatch(/DROP|DELETE|UPDATE "/i);
  });
});
