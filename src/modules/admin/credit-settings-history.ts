import { PrismaService } from '../../prisma/prisma.service';
import { adminsById, type AdminRef } from './admin-directory';

/** Every field of UpdateCreditSettingsDto: what the dashboard can change. */
export const CREDIT_SETTING_FIELDS = [
  'signupBonusCredits',
  'adRewardCredits',
  'adDailyCap',
  'referralInviterCredits',
  'referralInviteeCredits',
  'referralCapCount',
  'referralCapDays',
  'ipSignupLimitPer24h',
  'otpMaxAttempts',
  'otpResendCooldownSeconds',
  'otpPerEmailPerHour',
  'otpPerDevicePerHour',
  'otpPerIpPerHour',
  'disposableEmailDomains',
  'dailyRewardEnabled',
  'dailyRewardCredits',
] as const;

export type CreditSettingField = (typeof CREDIT_SETTING_FIELDS)[number];

export interface FieldChange {
  at: Date;
  by: AdminRef | null;
}

const PAGE = 200;

/** Arrays by element, in order (a reordered list is a change); everything else by identity. */
function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => item === b[i]);
  }
  return a === b;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * When each setting last changed, and who changed it. The settings row keeps
 * one updatedAt for all of them, but every save is audited with the whole row
 * before and after, so each field's newest change can be read back from there.
 * Reads newest first, stops once every field is accounted for, and never reads
 * more than `maxEntries` entries. A field never changed has no key.
 */
export async function lastChangedByField(
  prisma: PrismaService,
  maxEntries = 1000,
): Promise<Partial<Record<CreditSettingField, FieldChange>>> {
  const pending = new Set<CreditSettingField>(CREDIT_SETTING_FIELDS);
  const found = new Map<CreditSettingField, { at: Date; actorId: string | null }>();
  let cursor: string | undefined;
  let scanned = 0;

  while (pending.size > 0 && scanned < maxEntries) {
    const take = Math.min(PAGE, maxEntries - scanned);
    const page = await prisma.auditLog.findMany({
      // (entityType, entityId) is indexed; filtering on action alone would read the whole log.
      where: { entityType: 'CreditSettings', entityId: 'default', action: 'credits.settings.updated' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, actorId: true, createdAt: true, before: true, after: true },
    });
    if (page.length === 0) break;

    for (const entry of page) {
      const { before, after } = entry;
      if (!isRecord(before) || !isRecord(after)) continue;
      for (const field of pending) {
        if (field in before && field in after && !sameValue(before[field], after[field])) {
          found.set(field, { at: entry.createdAt, actorId: entry.actorId });
          pending.delete(field);
        }
      }
    }
    scanned += page.length;
    cursor = page[page.length - 1].id;
    // A short page is the last one: some fields have simply never changed.
    if (page.length < take) break;
  }

  const admins = await adminsById(prisma, [...found.values()].map((f) => f.actorId));
  const result: Partial<Record<CreditSettingField, FieldChange>> = {};
  for (const [field, { at, actorId }] of found) {
    result[field] = { at, by: (actorId && admins.get(actorId)) || null };
  }
  return result;
}
