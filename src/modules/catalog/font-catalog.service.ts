import { HttpStatus, Injectable } from '@nestjs/common';

import { CacheService } from '../../core/cache/cache.service';
import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import type { Prisma } from '../../generated/prisma/client';
import { AssetKind, AssetStatus, FileRole, Visibility } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { PREVIEW_HEIGHT, PREVIEW_WIDTH } from '../fonts/font-preview';

export interface CatalogFont {
  id: string;
  displayName: string;
  familyName: string;
  styleName: string;
  version: number;
  format: string;
  preview: { url: string; width: number; height: number } | null;
}

const CACHE_TTL_SECONDS = 300;
const NAMESPACE = `catalog:${AssetKind.font}`;

/** A font the app may fetch by id or family: published and not private (unlisted is fine). */
const FETCHABLE = {
  kind: AssetKind.font,
  status: AssetStatus.published,
  deletedAt: null,
  visibility: { not: Visibility.private },
} as const;

/** The current file first (the primary original), then the preview. */
const FONT_INCLUDE = {
  font: true,
  files: {
    where: { role: { in: [FileRole.original, FileRole.specimen] } },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }],
  },
} satisfies Prisma.AssetInclude;

const notFound = (message: string) => appError(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, message);

type FontRow = Prisma.AssetGetPayload<{ include: typeof FONT_INCLUDE }>;

function toItem(row: FontRow): CatalogFont {
  const original = row.files.find((f) => f.role === FileRole.original);
  const specimen = row.files.find((f) => f.role === FileRole.specimen);
  return {
    id: row.id,
    displayName: row.title,
    familyName: row.font!.familyName,
    styleName: row.font!.styleName,
    version: row.font!.version,
    format: original?.format ?? 'ttf',
    preview: specimen?.deliveryUrl ? { url: specimen.deliveryUrl, width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT } : null,
  };
}

/**
 * The app's font catalogue: every published font in the owner's order (or,
 * still supported, the fonts of one category), plus lookups by id and, for
 * projects made before font ids, by family name. Downloads go through the
 * shared download endpoint.
 */
@Injectable()
export class FontCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  /**
   * With no category: every published, public font with a preview, in the
   * owner's order, newest first among equal positions. With one (kept for
   * older callers): the fonts filed in that category.
   */
  list(categorySlug?: string): Promise<CatalogFont[]> {
    return this.cache.wrap(
      NAMESPACE,
      categorySlug ? ['fonts', categorySlug] : ['fonts:all'],
      async () => {
        let categoryId: string | undefined;
        if (categorySlug) {
          const category = await this.prisma.category.findFirst({
            where: { kind: AssetKind.font, slug: categorySlug, isActive: true },
          });
          if (!category) throw notFound(`No font category "${categorySlug}".`);
          categoryId = category.id;
        }
        const rows = await this.prisma.asset.findMany({
          where: {
            ...FETCHABLE,
            visibility: Visibility.public,
            ...(categoryId ? { categoryId } : {}),
            // The app shows fonts by their preview: a font without one is left out.
            files: { some: { role: FileRole.specimen } },
          },
          orderBy: categoryId
            ? [{ font: { sortOrder: 'asc' } }, { id: 'asc' }]
            : [{ font: { sortOrder: 'asc' } }, { createdAt: 'desc' }],
          include: FONT_INCLUDE,
        });
        return rows.map(toItem);
      },
      CACHE_TTL_SECONDS,
    );
  }

  byId(id: string): Promise<CatalogFont> {
    return this.cache.wrap(
      NAMESPACE,
      ['font', id],
      async () => {
        const row = await this.prisma.asset.findFirst({ where: { ...FETCHABLE, id }, include: FONT_INCLUDE });
        if (!row?.font) throw notFound(`Font not found: ${id}`);
        return toItem(row);
      },
      CACHE_TTL_SECONDS,
    );
  }

  /**
   * For projects made before font ids: they store only the family name and
   * always drew the Regular face. Exact spelling, Regular style.
   */
  byFamily(familyName: string): Promise<CatalogFont> {
    return this.cache.wrap(
      NAMESPACE,
      ['family', familyName],
      async () => {
        const row = await this.prisma.asset.findFirst({
          where: { ...FETCHABLE, font: { familyName, styleKey: 'regular' } },
          include: FONT_INCLUDE,
        });
        if (!row?.font) throw notFound(`No Regular font in the family "${familyName}".`);
        return toItem(row);
      },
      CACHE_TTL_SECONDS,
    );
  }
}
