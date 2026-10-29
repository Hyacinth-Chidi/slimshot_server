import { PrismaService } from '../../prisma/prisma.service';

/** What an audit entry's entity is called, and whether it is gone. */
export interface EntityLabel {
  label: string | null;
  deleted: boolean;
}

const PROVIDER_NAMES: Record<string, string> = { deepgram: 'Deepgram', elevenlabs: 'ElevenLabs' };

type Lookup = (prisma: PrismaService, ids: string[]) => Promise<Map<string, EntityLabel>>;

/**
 * One lookup per entity type the audit log writes. `missing` is what an id with
 * no row means: categories, users and provider keys are removed outright or
 * scrubbed, so their absence means "deleted"; for the rest it means unknown.
 */
const LOOKUPS: Record<string, { find: Lookup; missing: EntityLabel }> = {
  Asset: {
    missing: { label: null, deleted: false },
    find: async (prisma, ids) => {
      const rows = await prisma.asset.findMany({ where: { id: { in: ids } }, select: { id: true, title: true, deletedAt: true } });
      // A deleted sound or font keeps its row, so it keeps its name.
      return new Map(rows.map((r) => [r.id, { label: r.title, deleted: r.deletedAt !== null }]));
    },
  },
  User: {
    missing: { label: null, deleted: true },
    find: async (prisma, ids) => {
      const rows = await prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, username: true, email: true, accountStatus: true },
      });
      return new Map(rows.map((r) => [r.id, { label: r.username ?? r.email ?? null, deleted: r.accountStatus === 'deleted' }]));
    },
  },
  Category: {
    missing: { label: null, deleted: true },
    find: async (prisma, ids) => {
      const rows = await prisma.category.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
      return new Map(rows.map((r) => [r.id, { label: r.name, deleted: false }]));
    },
  },
  PricingRule: {
    missing: { label: null, deleted: false },
    find: async (prisma, ids) => {
      const rows = await prisma.pricingRule.findMany({ where: { id: { in: ids } }, select: { id: true, version: true } });
      return new Map(rows.map((r) => [r.id, { label: `v${r.version}`, deleted: false }]));
    },
  },
  ProviderCredential: {
    missing: { label: null, deleted: true },
    find: async (prisma, ids) => {
      const rows = await prisma.providerCredential.findMany({ where: { id: { in: ids } }, select: { id: true, provider: true } });
      return new Map(rows.map((r) => [r.id, { label: PROVIDER_NAMES[r.provider] ?? r.provider, deleted: false }]));
    },
  },
  AdminUser: {
    missing: { label: null, deleted: false },
    find: async (prisma, ids) => {
      const rows = await prisma.adminUser.findMany({ where: { id: { in: ids } }, select: { id: true, email: true, deletedAt: true } });
      return new Map(rows.map((r) => [r.id, { label: r.email, deleted: r.deletedAt !== null }]));
    },
  },
};

const NO_LABEL: EntityLabel = { label: null, deleted: false };

/**
 * Names for the entities of a page of audit entries, keyed `${entityType}:${entityId}`.
 * Exactly one query per entity type present; types with no name (CreditSettings,
 * FontOrder, anything new) get a null label without a query.
 */
export async function labelEntities(
  prisma: PrismaService,
  rows: Array<{ entityType: string; entityId: string | null }>,
): Promise<Map<string, EntityLabel>> {
  const idsByType = new Map<string, Set<string>>();
  for (const { entityType, entityId } of rows) {
    if (!entityType || !entityId) continue;
    const ids = idsByType.get(entityType) ?? new Set<string>();
    ids.add(entityId);
    idsByType.set(entityType, ids);
  }

  const labels = new Map<string, EntityLabel>();
  await Promise.all(
    [...idsByType].map(async ([type, idSet]) => {
      const ids = [...idSet];
      const lookup = LOOKUPS[type];
      const found = lookup ? await lookup.find(prisma, ids) : new Map<string, EntityLabel>();
      for (const id of ids) {
        labels.set(`${type}:${id}`, found.get(id) ?? (lookup ? lookup.missing : NO_LABEL));
      }
    }),
  );
  return labels;
}
