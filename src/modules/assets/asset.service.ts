import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AssetKind, AssetStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { CacheService } from '../../core/cache/cache.service';
import { AssetWithRelations, PublicAsset } from './asset-kind.interface';
import { ListAssetsDto } from './dto/list-assets.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';
import { KindRegistry } from './kind-registry';

const DETAIL_INCLUDE = { files: true, audio: true } as const;

/** Only a fully processed asset may go live. */
const PUBLISHABLE_FROM: readonly AssetStatus[] = [
  AssetStatus.ready,
  AssetStatus.archived,
];

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
  ): Promise<{ data: PublicAsset[]; meta: { nextCursor: string | null } }> {
    const rows = await this.prisma.asset.findMany({
      where: {
        deletedAt: null,
        ...(query.kind ? { kind: query.kind } : {}),
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
      data: rows.map((row) => this.toPublic(row as unknown as AssetWithRelations)),
      meta: {
        nextCursor:
          rows.length === query.limit ? (rows[rows.length - 1].id as string) : null,
      },
    };
  }

  async getById(id: string): Promise<PublicAsset> {
    return this.toPublic(await this.load(id));
  }

  async update(
    id: string,
    dto: UpdateAssetDto,
    actorId: string,
  ): Promise<PublicAsset> {
    const before = await this.load(id);

    const updated = await this.prisma.asset.update({
      where: { id },
      data: { ...dto, updatedById: actorId },
      include: DETAIL_INCLUDE,
    });

    // Only a live asset can have a stale cache entry.
    if (before.status === AssetStatus.published) {
      await this.invalidate(before.kind);
    }

    await this.audit.record({
      actorId,
      actorType: 'admin',
      action: 'asset.update',
      entityType: 'Asset',
      entityId: id,
      before: { title: before.title },
      after: dto,
    });

    return this.toPublic(updated as unknown as AssetWithRelations);
  }

  async publish(id: string, actorId: string): Promise<PublicAsset> {
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

    return this.toPublic(updated as unknown as AssetWithRelations);
  }

  async unpublish(id: string, actorId: string): Promise<PublicAsset> {
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

    return this.toPublic(updated as unknown as AssetWithRelations);
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

  private async load(id: string): Promise<AssetWithRelations & { status: AssetStatus }> {
    const row = await this.prisma.asset.findFirst({
      where: { id, deletedAt: null },
      include: DETAIL_INCLUDE,
    });

    if (!row) throw new NotFoundException(`Asset not found: ${id}`);
    return row as unknown as AssetWithRelations & { status: AssetStatus };
  }

  private toPublic(row: AssetWithRelations): PublicAsset {
    return this.kinds.get(row.kind).toPublicDto(row);
  }

  private async invalidate(kind: AssetKind): Promise<void> {
    await this.cache.bumpGeneration(`catalog:${kind}`);
  }
}
