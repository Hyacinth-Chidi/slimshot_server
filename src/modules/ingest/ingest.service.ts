import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { AssetKind, AssetStatus, FileRole } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { QueueService } from '../../core/queue/queue.service';
import { SettingsService } from '../../core/settings/settings.service';
import { StorageRegistry } from '../../core/storage/storage.registry';
import { KindRegistry } from '../assets/kind-registry';
import { CreateUploadTicketDto } from './dto/create-upload-ticket.dto';
import { FinalizeUploadDto } from './dto/finalize-upload.dto';

export interface TicketResponse {
  assetId: string;
  sessionId: string;
  uploadUrl: string;
  storageKey: string;
  fields: Record<string, string>;
  expiresAt: Date;
}

@Injectable()
export class IngestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kinds: KindRegistry,
    private readonly storage: StorageRegistry,
    private readonly settings: SettingsService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
  ) {}

  async createTicket(
    dto: CreateUploadTicketDto,
    actorId: string,
  ): Promise<TicketResponse> {
    const descriptor = this.kinds.get(dto.kind);

    const allowedMimeTypes = await this.settings.get<string[]>(
      descriptor.accepts.mimeTypesSetting,
    );
    const maxBytes = await this.settings.get<number>(
      descriptor.accepts.maxBytesSetting,
    );

    this.kinds.assertAccepts(
      dto.kind,
      dto.mimeType,
      dto.byteSize,
      allowedMimeTypes,
      maxBytes,
    );

    const title = dto.title?.trim() || titleFromFilename(dto.filename);
    const adapter = await this.storage.getDefault();
    const ttlSeconds = await this.settings.get<number>('upload.ticketTtlSeconds');

    const ticket = await adapter.createUploadTicket({
      folder: `slimshot/${dto.kind}`,
      filename: dto.filename,
      mimeType: dto.mimeType,
      ttlSeconds,
    });

    const asset = await this.prisma.asset.create({
      data: {
        kind: dto.kind,
        slug: `${slugify(title)}-${randomUUID().slice(0, 8)}`,
        title,
        authorName: dto.author?.trim() || 'SlimShot',
        status: AssetStatus.draft,
        createdById: actorId,
        updatedById: actorId,
      },
    });

    const session = await this.prisma.uploadSession.create({
      data: {
        assetId: asset.id,
        role: FileRole.original,
        storageId: adapter.id,
        storageKey: ticket.storageKey,
        expiresAt: ticket.expiresAt,
        declaredMime: dto.mimeType,
        declaredSize: dto.byteSize,
        createdById: actorId,
      },
    });

    await this.audit.record({
      actorId,
      actorType: 'admin',
      action: 'asset.upload.ticket',
      entityType: 'Asset',
      entityId: asset.id,
      after: { kind: dto.kind, filename: dto.filename },
    });

    return {
      assetId: asset.id,
      sessionId: session.id,
      uploadUrl: ticket.uploadUrl,
      storageKey: ticket.storageKey,
      fields: ticket.fields,
      expiresAt: ticket.expiresAt,
    };
  }

  async finalize(
    dto: FinalizeUploadDto,
    actorId: string,
  ): Promise<{ assetId: string; status: AssetStatus }> {
    const session = await this.prisma.uploadSession.findUnique({
      where: { id: dto.sessionId },
      include: { asset: true },
    });

    if (!session) throw new NotFoundException('Upload session not found.');

    if (session.state === 'finalized') {
      throw new BadRequestException('This upload session is already finalized.');
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('This upload session has expired.');
    }

    const adapter = await this.storage.get(session.storageId);

    // The only source of truth for size, format and duration is the provider.
    let remote;
    try {
      remote = await adapter.verifyUpload(session.storageKey);
    } catch (error) {
      await this.prisma.asset.update({
        where: { id: session.assetId },
        data: { status: AssetStatus.failed },
      });
      throw new BadRequestException(
        `Upload could not be verified in storage: ${(error as Error).message}`,
      );
    }

    const kind = (session as { asset: { kind: AssetKind } }).asset.kind;
    const descriptor = this.kinds.get(kind);

    await this.prisma.assetFile.create({
      data: {
        assetId: session.assetId,
        role: session.role,
        storageId: session.storageId,
        storageKey: remote.storageKey,
        deliveryUrl: remote.deliveryUrl,
        mimeType: remote.mimeType,
        format: remote.format,
        byteSize: remote.byteSize,
        durationMs: remote.durationMs ?? null,
        width: remote.width ?? null,
        height: remote.height ?? null,
        checksumSha256: remote.checksumSha256 ?? null,
        isPrimary: session.role === FileRole.original,
      },
    });

    const detail = descriptor.buildDetail(remote);
    if (kind === AssetKind.audio) {
      await this.prisma.audioAsset.upsert({
        where: { assetId: session.assetId },
        create: { assetId: session.assetId, ...(detail as { durationMs: number }) },
        update: detail as { durationMs: number },
      });
    }

    await this.prisma.uploadSession.update({
      where: { id: session.id },
      data: { state: 'finalized', finalizedAt: new Date() },
    });

    await this.prisma.asset.update({
      where: { id: session.assetId },
      data: { status: AssetStatus.processing, updatedById: actorId },
    });

    for (const processor of descriptor.processors) {
      await this.queue.enqueueAssetProcessing({
        assetId: session.assetId,
        processor,
      });
    }

    await this.audit.record({
      actorId,
      actorType: 'admin',
      action: 'asset.upload.finalized',
      entityType: 'Asset',
      entityId: session.assetId,
      after: { byteSize: remote.byteSize, durationMs: remote.durationMs },
    });

    return { assetId: session.assetId, status: AssetStatus.processing };
  }
}

function titleFromFilename(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
