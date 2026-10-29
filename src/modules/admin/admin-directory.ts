import { PrismaService } from '../../prisma/prisma.service';

/** How an admin is named in admin responses: who set a price, who changed a setting. */
export interface AdminRef {
  id: string;
  email: string;
  name: string;
}

/**
 * Every distinct id in one query. Soft-deleted admins are included on purpose:
 * what they did still happened, so it keeps their name. An id with no row is
 * simply absent from the map.
 */
export async function adminsById(
  prisma: PrismaService,
  ids: Array<string | null | undefined>,
): Promise<Map<string, AdminRef>> {
  const distinct = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (distinct.length === 0) return new Map();

  const rows = await prisma.adminUser.findMany({
    where: { id: { in: distinct } },
    select: { id: true, email: true, name: true },
  });
  return new Map(rows.map((row) => [row.id, { id: row.id, email: row.email, name: row.name }]));
}

/** Each row with its creator named, for "set by"; null once that admin has no row. One lookup. */
export async function withCreators<T extends { createdById: string }>(
  prisma: PrismaService,
  rows: T[],
): Promise<Array<T & { createdBy: AdminRef | null }>> {
  const admins = await adminsById(prisma, rows.map((r) => r.createdById));
  return rows.map((row) => ({ ...row, createdBy: admins.get(row.createdById) ?? null }));
}
