import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ProviderCapability, ProviderKind } from '../generated/prisma/enums';

describe('provider schema', () => {
  it('knows the three speech-to-text providers', () => {
    expect(Object.values(ProviderKind)).toEqual(['deepgram', 'elevenlabs', 'xai']);
    expect(Object.values(ProviderCapability)).toEqual(['speech_to_text']);
  });

  it('adds xAI with an additive migration that touches no existing row', () => {
    const sql = readFileSync(
      join(__dirname, '../../prisma/migrations/20261029120000_add_xai_provider/migration.sql'),
      'utf8',
    );
    const statements = sql
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('--'));
    expect(statements).toEqual([
      `ALTER TYPE "ProviderKind" ADD VALUE 'xai';`,
    ]);
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
