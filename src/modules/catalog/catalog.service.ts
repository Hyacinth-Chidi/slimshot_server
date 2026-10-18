import { HttpStatus, Injectable } from '@nestjs/common';

import { CacheService } from '../../core/cache/cache.service';
import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import type { Prisma } from '../../generated/prisma/client';
import { AssetKind, AssetStatus, FileRole, Visibility } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { subtreeIds } from '../taxonomy/category-tree';
import * as entitlement from './entitlement';

export interface CatalogCategory {
  id: string;
  slug: string;
  name: string;
  children: CatalogCategory[];
}

export interface CatalogItem {
  id: string;
  slug: string;
  title: string;
  author: string;
  durationMs: number;
  category: { slug: string; name: string } | null;
  cover: { url: string } | null;
}

export interface CatalogPage {
  items: CatalogItem[];
  nextCursor: string | null;
}

export interface DownloadTicket {
  url: string;
  expiresAt: string;
  filename: string;
  format: string;
  byteSize: number;
  durationMs: number;
}

export interface CatalogAssetsQuery {
  kind: AssetKind;
  category?: string;
  cursor?: string;
  limit: number;
}

const CACHE_TTL_SECONDS = 300;
const DOWNLOAD_URL_LIFETIME_MS = 10 * 60 * 1000;

/** What the app may list: live, public, not deleted. */
const LISTED = {
  status: AssetStatus.published,
  deletedAt: null,
  visibility: Visibility.public,
} as const;

const notFound = (message: string) => appError(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, message);
const invalid = (message: string) =>
  appError(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.VALIDATION_FAILED, message);

/**
 * The app's sound catalogue: categories under a fixed root, the sounds in them,
 * and downloads. Reads are cached under `catalog:<kind>`, whose generation every
 * admin change bumps, so edits show at once.
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  categories(kind: AssetKind, rootSlug: string): Promise<CatalogCategory[]> {
    return this.cache.wrap(
      `catalog:${kind}`,
      ['categories', rootSlug],
      async () => {
        const rows = await this.prisma.category.findMany({
          where: { kind },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          select: { id: true, parentId: true, slug: true, name: true, isActive: true },
        });
        const root = rows.find((r) => r.slug === rootSlug && r.parentId === null && r.isActive);
        if (!root) throw notFound(`No category "${rootSlug}" for ${kind}.`);

        const childrenOf = (parentId: string): CatalogCategory[] =>
          rows
            .filter((r) => r.parentId === parentId && r.isActive)
            .map((r) => ({ id: r.id, slug: r.slug, name: r.name, children: childrenOf(r.id) }));
        return childrenOf(root.id);
      },
      CACHE_TTL_SECONDS,
    );
  }

  assets(q: CatalogAssetsQuery): Promise<CatalogPage> {
    return this.cache.wrap(
      `catalog:${q.kind}`,
      ['assets', q.category ?? null, q.cursor ?? null, q.limit],
      () => this.loadAssets(q),
      CACHE_TTL_SECONDS,
    );
  }

  private async loadAssets(q: CatalogAssetsQuery): Promise<CatalogPage> {
    let categoryIds: string[] | undefined;
    if (q.category) {
      const rows = await this.prisma.category.findMany({
        where: { kind: q.kind },
        select: { id: true, parentId: true, slug: true, isActive: true },
      });
      const start = rows.find((r) => r.slug === q.category && r.isActive);
      if (!start) throw notFound(`No category "${q.category}" for ${q.kind}.`);
      categoryIds = subtreeIds(rows, start.id, { activeOnly: true });
    }

    const where: Prisma.AssetWhereInput = {
      kind: q.kind,
      ...LISTED,
      ...(categoryIds ? { categoryId: { in: categoryIds } } : {}),
    };

    // Keyset paging on (publishedAt, id): a sound published mid-scroll never
    // shifts the pages the app has already seen.
    if (q.cursor) {
      const at = await this.prisma.asset.findFirst({
        where: { ...where, id: q.cursor },
        select: { id: true, publishedAt: true },
      });
      if (!at?.publishedAt) throw invalid(`Cursor ${q.cursor} is not in this listing.`);
      where.AND = [
        { OR: [{ publishedAt: { lt: at.publishedAt } }, { publishedAt: at.publishedAt, id: { lt: at.id } }] },
      ];
    }

    const rows = await this.prisma.asset.findMany({
      where,
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      include: {
        audio: true,
        category: { select: { slug: true, name: true } },
        files: { where: { role: FileRole.thumbnail }, take: 1 },
      },
    });

    const page = rows.slice(0, q.limit);
    return {
      items: page.map((a) => ({
        id: a.id,
        slug: a.slug,
        title: a.title,
        author: a.authorName,
        durationMs: a.audio?.durationMs ?? 0,
        category: a.category ? { slug: a.category.slug, name: a.category.name } : null,
        cover: a.files[0]?.deliveryUrl ? { url: a.files[0].deliveryUrl } : null,
      })),
      nextCursor: rows.length > q.limit ? page[page.length - 1].id : null,
    };
  }

  /**
   * The download checkpoint. Unlisted sounds download by direct id; unknown,
   * unpublished, deleted and private ones all look the same: 404.
   */
  async download(id: string): Promise<DownloadTicket> {
    const asset = await this.prisma.asset.findFirst({
      where: {
        id,
        status: AssetStatus.published,
        deletedAt: null,
        visibility: { not: Visibility.private },
      },
      include: { audio: true, files: { where: { role: FileRole.original }, take: 1 } },
    });
    const original = asset?.files[0];
    if (!asset || !original?.deliveryUrl) throw notFound(`Asset not found: ${id}`);
    if (!entitlement.canDownload(asset)) {
      throw appError(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, 'This sound cannot be downloaded.');
    }

    await this.prisma.asset.update({ where: { id }, data: { downloadCount: { increment: 1 } } });

    return {
      url: original.deliveryUrl,
      expiresAt: new Date(Date.now() + DOWNLOAD_URL_LIFETIME_MS).toISOString(),
      filename: `${asset.slug}.${original.format}`,
      format: original.format,
      byteSize: original.byteSize,
      durationMs: original.durationMs ?? asset.audio?.durationMs ?? 0,
    };
  }
}
