import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { uploadConfig, type UploadConfig } from '../../config';
import { AuditService } from '../../core/audit/audit.service';
import { CacheService } from '../../core/cache/cache.service';
import { probeFont, type FontNames } from '../../core/storage/font-probe';
import {
  StorageProviderAdapter,
  UnreadableUploadError,
} from '../../core/storage/storage-adapter.interface';
import { StorageRegistry } from '../../core/storage/storage.registry';
import { AssetKind, AssetStatus, FileRole } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import * as preview from './font-preview';

export interface FontUploadSession {
  id: string;
  assetId: string;
  storageId: string;
  storageKey: string;
  declaredMime: string;
  asset: { kind: AssetKind; status: AssetStatus; categoryId: string | null; title: string };
}

type StoredFile = { id: string; storageId: string; storageKey: string };

const faceName = (n: { familyName: string; styleName: string }) => `${n.familyName} ${n.styleName}`;
const key = (s: string) => s.trim().toLowerCase();

/**
 * Font uploads: a new face, or a new version of one. Every file is kept, the
 * current one is the primary original, and each font carries a preview tile
 * drawn from its own file.
 */
@Injectable()
export class FontsService {
  private readonly logger = new Logger(FontsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageRegistry,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    @Inject(uploadConfig.KEY) private readonly upload: UploadConfig,
  ) {}

  async finalizeUpload(
    session: FontUploadSession,
    adapter: StorageProviderAdapter,
    actorId: string,
  ): Promise<{ assetId: string; status: AssetStatus }> {
    const existing = await this.prisma.fontAsset.findUnique({ where: { assetId: session.assetId } });
    // A failed new font is marked failed; a failed new version leaves the font as it was.
    const markFailed = !existing;

    let remote;
    try {
      remote = await adapter.verifyUpload(session.storageKey, probeFont);
    } catch (error) {
      if (error instanceof UnreadableUploadError) await this.refuse(session, adapter, error.message, markFailed);
      if (markFailed) await this.markFailed(session.assetId);
      throw new BadRequestException(`Upload could not be verified in storage: ${(error as Error).message}`);
    }

    const limits = this.upload.limits[AssetKind.font]!;
    if (!limits.mimeTypes.includes(remote.mimeType)) {
      await this.refuse(session, adapter, `${remote.mimeType} is not an accepted font type.`, markFailed);
    }
    if (remote.mimeType !== session.declaredMime) {
      await this.refuse(
        session,
        adapter,
        `The file is ${remote.format.toUpperCase()} (${remote.mimeType}), but it was uploaded as ${session.declaredMime}.`,
        markFailed,
      );
    }
    if (remote.byteSize > limits.maxBytes) {
      await this.refuse(
        session,
        adapter,
        `File size ${remote.byteSize} exceeds the configured maximum of ${limits.maxBytes} bytes.`,
        markFailed,
      );
    }

    const names = remote.details as FontNames;
    return existing
      ? this.addVersion(session, adapter, names, remote, existing, actorId)
      : this.addFont(session, adapter, names, remote, actorId);
  }

  private async addFont(
    session: FontUploadSession,
    adapter: StorageProviderAdapter,
    names: FontNames,
    remote: { storageKey: string; deliveryUrl: string; mimeType: string; format: string; byteSize: number },
    actorId: string,
  ): Promise<{ assetId: string; status: AssetStatus }> {
    const taken = await this.prisma.fontAsset.findUnique({
      where: { familyKey_styleKey: { familyKey: key(names.familyName), styleKey: key(names.styleName) } },
    });
    if (taken) await this.refuse(session, adapter, `${faceName(names)} is already in the library.`, true);

    // A new font goes to the end of its category's order.
    const { _max } = await this.prisma.fontAsset.aggregate({
      where: { asset: { categoryId: session.asset.categoryId } },
      _max: { sortOrder: true },
    });
    const sortOrder = _max.sortOrder === null ? 0 : _max.sortOrder + 1;

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.fontAsset.create({
          data: {
            assetId: session.assetId,
            familyName: names.familyName,
            styleName: names.styleName,
            fullName: names.fullName,
            postscriptName: names.postscriptName,
            familyKey: key(names.familyName),
            styleKey: key(names.styleName),
            version: 1,
            sortOrder,
          },
        });
        await tx.assetFile.create({ data: this.originalRow(session, remote, 1) });
        // Named from the file: the display name starts as the face's full name.
        await tx.asset.update({
          where: { id: session.assetId },
          data: { title: names.fullName, status: AssetStatus.ready, updatedById: actorId },
        });
        await tx.uploadSession.update({
          where: { id: session.id },
          data: { state: 'finalized', finalizedAt: new Date() },
        });
      });
    } catch (error) {
      // Two uploads of one face at once: the database's unique key decides.
      if ((error as { code?: string }).code === 'P2002') {
        await this.refuse(session, adapter, `${faceName(names)} is already in the library.`, true);
      }
      throw error;
    }

    const bytes = await adapter.getObject(session.storageKey);
    await this.storePreview(session.assetId, adapter, bytes, names.fullName);
    await this.cache.bumpGeneration(`catalog:${AssetKind.font}`);
    await this.audit.record({
      actorId,
      actorType: 'admin',
      action: 'asset.upload.finalized',
      entityType: 'Asset',
      entityId: session.assetId,
      after: { font: faceName(names), byteSize: remote.byteSize },
    });
    return { assetId: session.assetId, status: AssetStatus.ready };
  }

  private async addVersion(
    session: FontUploadSession,
    adapter: StorageProviderAdapter,
    names: FontNames,
    remote: { storageKey: string; deliveryUrl: string; mimeType: string; format: string; byteSize: number },
    existing: { familyName: string; styleName: string; familyKey: string; styleKey: string; version: number },
    actorId: string,
  ): Promise<{ assetId: string; status: AssetStatus }> {
    if (key(names.familyName) !== existing.familyKey || key(names.styleName) !== existing.styleKey) {
      await this.refuse(session, adapter, `This file is ${faceName(names)}, not ${faceName(existing)}.`, false);
    }
    const version = existing.version + 1;

    await this.prisma.$transaction(async (tx) => {
      // Every earlier file stays: projects and exports made with it keep working.
      await tx.assetFile.updateMany({
        where: { assetId: session.assetId, role: FileRole.original },
        data: { isPrimary: false },
      });
      await tx.assetFile.create({ data: this.originalRow(session, remote, version) });
      await tx.fontAsset.update({ where: { assetId: session.assetId }, data: { version } });
      await tx.uploadSession.update({
        where: { id: session.id },
        data: { state: 'finalized', finalizedAt: new Date() },
      });
    });

    const bytes = await adapter.getObject(session.storageKey);
    await this.storePreview(session.assetId, adapter, bytes, session.asset.title);
    await this.cache.bumpGeneration(`catalog:${AssetKind.font}`);
    await this.audit.record({
      actorId,
      actorType: 'admin',
      action: 'font.version',
      entityType: 'Asset',
      entityId: session.assetId,
      after: { version },
    });
    return { assetId: session.assetId, status: session.asset.status };
  }

  /** Redraws a font's preview from its current file and display name. False if it could not be drawn. */
  async refreshPreview(assetId: string): Promise<boolean> {
    const asset = await this.prisma.asset.findFirst({ where: { id: assetId, deletedAt: null } });
    if (!asset) throw new NotFoundException(`Asset not found: ${assetId}`);
    const original = await this.prisma.assetFile.findFirst({
      where: { assetId, role: FileRole.original, isPrimary: true },
    });
    if (!original) return false;
    const adapter = await this.storage.get(original.storageId);
    const drawn = await this.storePreview(assetId, adapter, await adapter.getObject(original.storageKey), asset.title);
    if (drawn) await this.cache.bumpGeneration(`catalog:${AssetKind.font}`);
    return drawn;
  }

  /** Draws and stores the preview, replacing the previous one. On failure nothing changes. */
  private async storePreview(
    assetId: string,
    adapter: StorageProviderAdapter,
    fontBytes: Buffer,
    text: string,
  ): Promise<boolean> {
    let png: Buffer;
    try {
      png = preview.renderFontPreview(fontBytes, text);
    } catch (error) {
      this.logger.warn(`Could not draw the preview of font ${assetId}: ${(error as Error).message}`);
      return false;
    }

    const storageKey = `slimshot/fonts/previews/${randomUUID()}.png`;
    await adapter.putObject(storageKey, png, 'image/png');

    const previous = await this.prisma.$transaction(async (tx) => {
      const old = (await tx.assetFile.findMany({
        where: { assetId, role: FileRole.specimen },
        select: { id: true, storageId: true, storageKey: true },
      })) as StoredFile[];
      if (old.length > 0) await tx.assetFile.deleteMany({ where: { id: { in: old.map((f) => f.id) } } });
      await tx.assetFile.create({
        data: {
          assetId,
          role: FileRole.specimen,
          storageId: adapter.id,
          storageKey,
          deliveryUrl: adapter.getDeliveryUrl(storageKey),
          mimeType: 'image/png',
          format: 'png',
          byteSize: png.length,
          width: preview.PREVIEW_WIDTH,
          height: preview.PREVIEW_HEIGHT,
          isPrimary: false,
        },
      });
      return old;
    });

    for (const file of previous) {
      try {
        await (await this.storage.get(file.storageId)).delete(file.storageKey);
      } catch (error) {
        this.logger.warn(`Could not delete replaced preview ${file.storageKey}: ${(error as Error).message}`);
      }
    }
    return true;
  }

  private originalRow(
    session: FontUploadSession,
    remote: { storageKey: string; deliveryUrl: string; mimeType: string; format: string; byteSize: number },
    version: number,
  ) {
    return {
      assetId: session.assetId,
      role: FileRole.original,
      storageId: session.storageId,
      storageKey: remote.storageKey,
      deliveryUrl: remote.deliveryUrl,
      mimeType: remote.mimeType,
      format: remote.format,
      byteSize: remote.byteSize,
      isPrimary: true,
      variant: { version },
    };
  }

  private async markFailed(assetId: string): Promise<void> {
    await this.prisma.asset.update({ where: { id: assetId }, data: { status: AssetStatus.failed } });
  }

  /** The upload can't be used: report why, delete it, and mark a new font failed. */
  private async refuse(
    session: { assetId: string; storageKey: string },
    adapter: StorageProviderAdapter,
    reason: string,
    markFailed: boolean,
  ): Promise<never> {
    if (markFailed) await this.markFailed(session.assetId);
    await adapter.delete(session.storageKey).catch(() => undefined);
    throw new BadRequestException(reason);
  }
}
