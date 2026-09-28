import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ProviderCapability, ProviderKind } from '../generated/prisma/enums';

describe('provider schema', () => {
  it('knows both speech-to-text providers', () => {
    expect(Object.values(ProviderKind)).toEqual(['deepgram', 'elevenlabs']);
    expect(Object.values(ProviderCapability)).toEqual(['speech_to_text']);
  });

  it('keeps the index that lets the database refuse two active providers', () => {
    // Prisma's schema language cannot express a partial index, so it lives only
    // in the hand-finished migration. Regenerating the migration would drop it.
    const sql = readFileSync(
      join(__dirname, '../../prisma/migrations/20260928120000_add_providers_and_devices/migration.sql'),
      'utf8',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "ProviderCredential_one_active" ON "ProviderCredential"("capability") WHERE "isActive";',
    );
  });
});
