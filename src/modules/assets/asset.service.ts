import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AssetKind, AssetStatus, FileRole } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { CacheService } from '../../core/cache/cache.service';
import { assertCategoryAssignable } from '../taxonomy/category-rules';
import { subtreeIds } from '../taxonomy/category-tree';
import { AssetWithRelations, PublicAsset, PublicAssetFile } from './asset-kind.interface';
import { ListAssetsDto } from './dto/list-assets.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';
import { KindRegistry } from './kind-registry';

const DETAIL_INCLUDE = { files: true, audio: true, font: true } as const;

/** A font's own facts, shown to the admin. Null for every other kind. */
export interface FontView {
  familyName: string;
  styleName: string;
  fullName: string;
  postscriptName: string | null;
  version: number;
  sortOrder: number;
  firstPublishedAt: string | null;
  license: string | null;
}

/** Only a fully processed asset may go live. */
const PUBLISHABLE_FROM: readonly AssetStatus[] = [
  AssetStatus.ready,
  AssetStatus.archived,
];

/** What the dashboard sees: the public shape plus lifecycle, filing and the original. */
export type AdminAsset = PublicAsset & {
  status: AssetStatus;
  visibility: string;
  categoryId: string | null;
  createdAt: string;
  publishedAt: string | null;
  font: FontView | null;
};

type AdminRow = AssetWithRelations & {
  status: AssetStatus;
  visibility: string;
  categoryId: string | null;
  createdAt: Date;
  publishedAt: Date | null;
  font?: (Omit<FontView, 'firstPublishedAt'> & { firstPublishedAt: Date | null }) | null;
};

function fileView(f: AssetWithRelations['files'][number]): PublicAssetFile {
  return {
    url: f.deliveryUrl ?? '',
    byteSize: f.byteSize,
    format: f.format,
    ...(f.durationMs !== null ? { durationMs: f.durationMs } : {}),
  };
}

@Injectable()
export class AssetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kinds: KindRegistry,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  async list(
    query: ListAssetsDto,
  ): Promise<{ data: AdminAsset[]; meta: { nextCursor: string | null } }> {
    let categoryIds: string[] | undefined;
    if (query.categoryId) {
      const category = await this.prisma.category.findUnique({
        where: { id: query.categoryId },
        select: { kind: true },
      });
      // A stale link to a deleted category lists nothing rather than everything.
      if (!category) return { data: [], meta: { nextCursor: null } };
      const tree = await this.prisma.category.findMany({
        where: { kind: category.kind },
        select: { id: true, parentId: true, isActive: true },
      });
      categoryIds = subtreeIds(tree, query.categoryId);
    }

    const rows = await this.prisma.asset.findMany({
      where: {
        deletedAt: null,
        ...(query.kind ? { kind: query.kind } : {}),
        ...(categoryIds ? { categoryId: { in: categoryIds } } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.q
          ? { title: { contains: query.q, mode: 'insensitive' as const } }
          : {}),
      },
      include: DETAIL_INCLUDE,
      take: query.limit,
      ...(query.cursor
        ? { cursor: { id: query.cursor }, skip: 1 }
        : {}),
      orderBy: { createdAt: 'desc' },
    });

    return {
      data: rows.map((row) => this.toAdmin(row as unknown as AdminRow)),
      meta: {
        nextCursor:
          rows.length === query.limit ? (rows[rows.length - 1].id as string) : null,
      },
    };
  }

  async getById(id: string): Promise<AdminAsset> {
    return this.toAdmin(await this.load(id));
  }

  async update(
    id: string,
    dto: UpdateAssetDto,
    actorId: string,
  ): Promise<AdminAsset> {
    const before = await this.load(id);
    if (dto.categoryId) await assertCategoryAssignable(this.prisma, dto.categoryId, before.kind);

    const updated = await this.prisma.asset.update({
      where: { id },
      data: { ...dto, updatedById: actorId, ...(await this.fontMove(before, dto.categoryId)) },
      include: DETAIL_INCLUDE,
    });

    // Always, not only when published: a cheap bump can never miss a case.
    await this.invalidate(before.kind);

    await this.audit.record({
      actorId,
      actorType: 'admin',
      action: 'asset.update',
      entityType: 'Asset',
      entityId: id,
      before: { title: before.title, categoryId: before.categoryId },
      after: dto,
    });

    return this.toAdmin(updated as unknown as AdminRow);
  }

  async publish(id: string, actorId: string): Promise<AdminAsset> {
    const asset = await this.load(id);

    if (!PUBLISHABLE_FROM.includes(asset.status)) {
      throw new BadRequestException(
        `An asset with status "${asset.status}" cannot be published. ` +
          `It must finish processing first.`,
      );
    }
    if (asset.kind === AssetKind.font) {
      // The app shows fonts by their preview: a font without one would be a blank tile.
      if (!asset.files.some((f) => f.role === FileRole.specimen)) {
        throw new BadRequestException('This font needs a preview before it can be published.');
      }
      // Recorded once and never cleared: from now on the font stays available for good.
      if (asset.font && !asset.font.firstPublishedAt) {
        await this.prisma.fontAsset.update({ where: { assetId: id }, data: { firstPublishedAt: new Date() } });
      }
    }

    const updated = await this.prisma.asset.update({
      where: { id },
      data: {
        status: AssetStatus.published,
        publishedAt: new Date(),
        updatedById: actorId,
      },
      include: DETAIL_INCLUDE,
    });

    await this.invalidate(asset.kind);
    await this.audit.record({
      actorId,
      actorType: 'admin',
      action: 'asset.publish',
      entityType: 'Asset',
      entityId: id,
    });

    return this.toAdmin(updated as unknown as AdminRow);
  }

  async unpublish(id: string, actorId: string): Promise<AdminAsset> {
    const asset = await this.load(id);

    const updated = await this.prisma.asset.update({
      where: { id },
      data: {
        status: AssetStatus.ready,
        publishedAt: null,
        updatedById: actorId,
      },
      include: DETAIL_INCLUDE,
    });

    await this.invalidate(asset.kind);
    await this.audit.record({
      actorId,
      actorType: 'admin',
      action: 'asset.unpublish',
      entityType: 'Asset',
      entityId: id,
    });

    return this.toAdmin(updated as unknown as AdminRow);
  }

  async softDelete(id: string, actorId: string): Promise<void> {
    const asset = await this.load(id);

    await this.prisma.asset.update({
      where: { id },
      data: { deletedAt: new Date(), updatedById: actorId },
    });
    // A deleted font frees its family and style for a fresh upload.
    if (asset.kind === AssetKind.font && asset.font) {
      await this.prisma.fontAsset.delete({ where: { assetId: id } });
    }

    await this.invalidate(asset.kind);
    await this.audit.record({
      actorId,
      actorType: 'admin',
      action: 'asset.delete',
      entityType: 'Asset',
      entityId: id,
    });
  }

  private async load(id: string): Promise<AdminRow> {
    const row = await this.prisma.asset.findFirst({
      where: { id, deletedAt: null },
      include: DETAIL_INCLUDE,
    });

    if (!row) throw new NotFoundException(`Asset not found: ${id}`);
    return row as unknown as AdminRow;
  }

  /**
   * A font filed into a category goes to the end of that category's order,
   * like a font uploaded straight into it; otherwise it would keep whatever
   * position it had elsewhere and could land at the top of the app's list.
   */
  private async fontMove(
    before: AdminRow,
    categoryId: string | null | undefined,
  ): Promise<{ font?: { update: { sortOrder: number } } }> {
    if (before.kind !== AssetKind.font || !before.font || !categoryId || categoryId === before.categoryId) return {};
    const { _max } = await this.prisma.fontAsset.aggregate({
      where: { asset: { categoryId, deletedAt: null } },
      _max: { sortOrder: true },
    });
    return { font: { update: { sortOrder: _max.sortOrder === null ? 0 : _max.sortOrder + 1 } } };
  }

  private toAdmin(row: AdminRow): AdminAsset {
    const base = this.kinds.get(row.kind).toPublicDto(row);
    // A font keeps every version's file; the current one is the primary.
    const originals = row.files.filter((f) => f.role === FileRole.original);
    const original = originals.find((f) => f.isPrimary) ?? originals[0];
    const thumbnail = row.files.find((f) => f.role === FileRole.thumbnail);
    return {
      ...base,
      files: {
        ...base.files,
        ...(original ? { original: fileView(original) } : {}),
        ...(thumbnail ? { thumbnail: fileView(thumbnail) } : {}),
      },
      status: row.status,
      visibility: row.visibility,
      categoryId: row.categoryId,
      createdAt: row.createdAt.toISOString(),
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
      font: row.font
        ? {
            familyName: row.font.familyName,
            styleName: row.font.styleName,
            fullName: row.font.fullName,
            postscriptName: row.font.postscriptName,
            version: row.font.version,
            sortOrder: row.font.sortOrder,
            firstPublishedAt: row.font.firstPublishedAt ? row.font.firstPublishedAt.toISOString() : null,
            license: row.font.license,
          }
        : null,
    };
  }

  private async invalidate(kind: AssetKind): Promise<void> {
    await this.cache.bumpGeneration(`catalog:${kind}`);
  }
}
