import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { uploadConfig, type UploadConfig, type UploadLimits } from '../../config';
import { AssetKind, AssetStatus, FileRole } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { QueueService } from '../../core/queue/queue.service';
import {
  StorageProviderAdapter,
  UnreadableUploadError,
} from '../../core/storage/storage-adapter.interface';
import { StorageRegistry } from '../../core/storage/storage.registry';
import { KindRegistry } from '../assets/kind-registry';
import { assertCategoryAssignable } from '../taxonomy/category-rules';
import { CreateUploadTicketDto } from './dto/create-upload-ticket.dto';
import { FinalizeUploadDto } from './dto/finalize-upload.dto';

export interface TicketResponse {
  assetId: string;
  sessionId: string;
  /** Presigned: send the file here with `method` and exactly these `headers`. */
  uploadUrl: string;
  method: 'PUT';
  headers: Record<string, string>;
  storageKey: string;
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
    @Inject(uploadConfig.KEY) private readonly upload: UploadConfig,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
  ) {}

  private limitsFor(kind: AssetKind): UploadLimits {
    const limits = this.upload.limits[kind];
    if (!limits) throw new BadRequestException(`Uploads are not configured for ${kind}.`);
    return limits;
  }

  async createTicket(
    dto: CreateUploadTicketDto,
    actorId: string,
  ): Promise<TicketResponse> {
    const { mimeTypes: allowedMimeTypes, maxBytes } = this.limitsFor(dto.kind);

    this.kinds.assertAccepts(
      dto.kind,
      dto.mimeType,
      dto.byteSize,
      allowedMimeTypes,
      maxBytes,
    );
    if (dto.categoryId) await assertCategoryAssignable(this.prisma, dto.categoryId, dto.kind);

    const title = dto.title?.trim() || titleFromFilename(dto.filename);
    const adapter = await this.storage.getDefault();
    const ttlSeconds = this.upload.ticketTtlSeconds;

    // The ticket is signed for this exact size and type, so a leaked one can
    // store nothing else; finalize then checks what actually landed.
    const ticket = await adapter.createUploadTicket({
      folder: `slimshot/${dto.kind}`,
      filename: dto.filename,
      mimeType: dto.mimeType,
      byteSize: dto.byteSize,
      ttlSeconds,
    });

    const asset = await this.prisma.asset.create({
      data: {
        kind: dto.kind,
        slug: `${slugify(title)}-${randomUUID().slice(0, 8)}`,
        title,
        authorName: dto.author?.trim() || 'SlimShot',
        status: AssetStatus.draft,
        ...(dto.categoryId ? { categoryId: dto.categoryId } : {}),
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
      method: ticket.method,
      headers: ticket.headers,
      storageKey: ticket.storageKey,
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

    // The only source of truth for size, format and duration is the stored
    // file itself, read back from the provider.
    let remote;
    try {
      remote = await adapter.verifyUpload(session.storageKey);
    } catch (error) {
      if (error instanceof UnreadableUploadError) {
        await this.refuse(session, adapter, error.message);
      }
      await this.markFailed(session.assetId);
      throw new BadRequestException(
        `Upload could not be verified in storage: ${(error as Error).message}`,
      );
    }

    const kind = (session as { asset: { kind: AssetKind } }).asset.kind;
    const descriptor = this.kinds.get(kind);
    const { mimeTypes: allowedMimeTypes, maxBytes } = this.limitsFor(kind);

    // createTicket validated what was DECLARED; these check what actually
    // landed. Without them an admin could declare audio/mpeg, upload an MP4,
    // and have it stored and catalogued.
    if (!allowedMimeTypes.includes(remote.mimeType)) {
      await this.refuse(
        session,
        adapter,
        `The uploaded file is ${remote.mimeType}, which is not accepted for ${kind}. ` +
          `Allowed: ${allowedMimeTypes.join(', ')}`,
      );
    }
    // R2 serves a file with the type it was uploaded as: a WAV declared as MP3
    // would reach players as audio/mpeg and fail to play.
    if (remote.mimeType !== session.declaredMime) {
      await this.refuse(
        session,
        adapter,
        `The file is ${remote.format.toUpperCase()} audio (${remote.mimeType}), but it was uploaded as ` +
          `${session.declaredMime}. Give it the right extension and upload it again.`,
      );
    }
    if (remote.byteSize > maxBytes) {
      await this.refuse(
        session,
        adapter,
        `File size ${remote.byteSize} exceeds the configured maximum of ${maxBytes} bytes.`,
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

  private async markFailed(assetId: string): Promise<void> {
    await this.prisma.asset.update({
      where: { id: assetId },
      data: { status: AssetStatus.failed },
    });
  }

  /**
   * The upload landed but cannot be catalogued: mark the asset failed, remove
   * the file (R2 keeps whatever it is sent, and nothing will ever point at it),
   * and answer with the reason. A failed removal must not hide that reason.
   */
  private async refuse(
    session: { assetId: string; storageKey: string },
    adapter: StorageProviderAdapter,
    reason: string,
  ): Promise<never> {
    await this.markFailed(session.assetId);
    await adapter.delete(session.storageKey).catch(() => undefined);
    throw new BadRequestException(reason);
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
