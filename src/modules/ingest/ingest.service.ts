import {
  BadRequestException,
  ForbiddenException,
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
  /**
   * No worker consumes the asset-processing queue yet — the audio preview and
   * waveform processors are a later phase. Until one exists, enqueuing would
   * strand assets in `processing` with nothing to advance them. Flip this to
   * true in the same change that adds the first worker.
   */
  private readonly processorsEnabled = false;

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
      // Bound what the ticket itself can write. Cloudinary cannot honour a
      // shorter lifetime than its own staleness window, so constraining size and
      // format is what actually limits the damage a leaked ticket can do.
      maxBytes,
      allowedFormats: descriptor.accepts.extensions.map((e) =>
        e.replace(/^\./, ''),
      ),
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

    // A session belongs to the admin who opened it. Without this, any principal
    // holding `asset.create` could finalize someone else's in-flight upload and
    // have it recorded against their own actor id in the audit trail.
    if (session.createdById !== actorId) {
      throw new ForbiddenException(
        'This upload session belongs to a different account.',
      );
    }

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

    // createTicket validated the DECLARED mime type; this validates what actually
    // landed. Without it an admin could declare audio/mpeg, upload an MP4, and
    // have it stored and catalogued — the provider is the source of truth, so the
    // allowlist has to be applied to the provider's answer too.
    const allowedMimeTypes = await this.settings.get<string[]>(
      descriptor.accepts.mimeTypesSetting,
    );
    if (!allowedMimeTypes.includes(remote.mimeType)) {
      await this.prisma.asset.update({
        where: { id: session.assetId },
        data: { status: AssetStatus.failed },
      });
      throw new BadRequestException(
        `The uploaded file is ${remote.mimeType}, which is not accepted for ${kind}. ` +
          `Allowed: ${allowedMimeTypes.join(', ')}`,
      );
    }

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

    // Only enter `processing` if something will actually move the asset out of it.
    // No worker consumes the queue yet (the audio processors are a later phase), so
    // parking every finalized asset in `processing` would leave it unpublishable
    // forever: publish() accepts only `ready`/`archived`, and nothing else writes
    // `ready`. When a kind declares no processors — or none are enqueued — the
    // asset is already complete and goes straight to `ready`.
    const willProcess = descriptor.processors.length > 0 && this.processorsEnabled;

    await this.prisma.asset.update({
      where: { id: session.assetId },
      data: {
        status: willProcess ? AssetStatus.processing : AssetStatus.ready,
        updatedById: actorId,
      },
    });

    if (willProcess) {
      for (const processor of descriptor.processors) {
        await this.queue.enqueueAssetProcessing({
          assetId: session.assetId,
          processor,
        });
      }
    }

    await this.audit.record({
      actorId,
      actorType: 'admin',
      action: 'asset.upload.finalized',
      entityType: 'Asset',
      entityId: session.assetId,
      after: { byteSize: remote.byteSize, durationMs: remote.durationMs },
    });

    return {
      assetId: session.assetId,
      status: willProcess ? AssetStatus.processing : AssetStatus.ready,
    };
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
