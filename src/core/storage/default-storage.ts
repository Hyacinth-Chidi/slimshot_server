import type { PrismaClient } from '../../generated/prisma/client';

export const R2_PROVIDER_NAME = 'Cloudflare R2';

type Db = Pick<PrismaClient, 'storageProvider' | '$transaction'>;

/**
 * Makes Cloudflare R2 the default storage provider: new uploads go wherever the
 * default row points. The row is identity only; credentials come from R2_* in
 * the environment and are never stored. The seed runs this on every deploy, so
 * it must be a no-op once R2 is the default.
 *
 * A database that still defaults to an older provider (Cloudinary, which was
 * removed) is switched over: that row stays, so the files pointing at it keep
 * their history, but it is no longer the default or active.
 */
export async function ensureR2Default(
  db: Db,
  bucket: string | undefined,
): Promise<'unchanged' | 'created' | 'switched'> {
  const current = await db.storageProvider.findFirst({ where: { isDefault: true } });
  if (current?.kind === 'r2') return 'unchanged';

  await db.$transaction(async (tx) => {
    await tx.storageProvider.updateMany({
      where: { isDefault: true, NOT: { name: R2_PROVIDER_NAME } },
      data: { isDefault: false, isActive: false },
    });
    await tx.storageProvider.upsert({
      where: { name: R2_PROVIDER_NAME },
      create: {
        kind: 'r2',
        name: R2_PROVIDER_NAME,
        isDefault: true,
        isActive: true,
        ...(bucket ? { publicConfig: { bucket } } : {}),
      },
      update: { isDefault: true, isActive: true },
    });
  });

  return current ? 'switched' : 'created';
}
