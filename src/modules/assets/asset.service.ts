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

const DETAIL_INCLUDE = { files: true, audio: true } as const;

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
};

type AdminRow = AssetWithRelations & {
  status: AssetStatus;
  visibility: string;
  categoryId: string | null;
  createdAt: Date;
  publishedAt: Date | null;
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
      data: { ...dto, updatedById: actorId },
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

  private toAdmin(row: AdminRow): AdminAsset {
    const base = this.kinds.get(row.kind).toPublicDto(row);
    const original = row.files.find((f) => f.role === FileRole.original);
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
    };
  }

  private async invalidate(kind: AssetKind): Promise<void> {
    await this.cache.bumpGeneration(`catalog:${kind}`);
  }
}
