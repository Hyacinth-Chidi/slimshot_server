import { randomUUID } from 'node:crypto';

import { HttpStatus, Injectable, Logger } from '@nestjs/common';

import { AuditService } from '../../core/audit/audit.service';
import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { StorageRegistry } from '../../core/storage/storage.registry';
import type { Voice } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { type ActiveVoiceProvider, ProviderCredentialsService } from '../providers/provider-credentials.service';
import { ProviderError } from '../providers/provider-error';

/** What every voice's sample says. One sentence, so samples compare like for like. */
export const SAMPLE_TEXT = 'Hi! This is how I sound in your video.';

/** Where samples are stored; a new key per sample, so a cached old one is never served. */
const SAMPLE_PREFIX = 'slimshot/voices/samples/';

/** A voice as the app lists it: switched on, with a sample to play for free. */
export interface AppVoice {
  id: string;
  label: string;
  sampleUrl: string;
}

const ORDER = [{ sortOrder: 'asc' as const }, { label: 'asc' as const }];

/**
 * The voices the owner offers. Synced from the provider switched off; the
 * owner names them, orders them, makes each one's sample and switches it on —
 * never without a sample, so the app never lists a voice it cannot preview.
 * A voice the provider stops listing is kept: a project mid-edit never loses
 * the voice it chose.
 */
@Injectable()
export class VoicesService {
  private readonly logger = new Logger(VoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: ProviderCredentialsService,
    private readonly storage: StorageRegistry,
    private readonly audit: AuditService,
  ) {}

  async listForApp(): Promise<AppVoice[]> {
    const rows = await this.prisma.voice.findMany({
      where: { enabled: true, sampleUrl: { not: null } },
      orderBy: ORDER,
      select: { id: true, label: true, sampleUrl: true },
    });
    return rows.map((r) => ({ id: r.id, label: r.label, sampleUrl: r.sampleUrl as string }));
  }

  listForAdmin(): Promise<Voice[]> {
    return this.prisma.voice.findMany({ orderBy: ORDER });
  }

  /** Adds the provider's voices not yet known, switched off, after the last one. */
  async sync(adminId: string): Promise<Voice[]> {
    const active = await this.activeProvider();
    let listed: Awaited<ReturnType<ActiveVoiceProvider['adapter']['listVoices']>>;
    try {
      listed = await active.adapter.listVoices(active.apiKey);
    } catch (err) {
      throw providerFailure(err);
    }

    const known = await this.prisma.voice.findMany({ where: { provider: active.adapter.kind } });
    const knownIds = new Set(known.map((v) => v.providerVoiceId));
    const all = await this.prisma.voice.findMany({});
    let next = all.reduce((max, v) => Math.max(max, v.sortOrder), -1) + 1;
    const added = listed
      .filter((v, i) => !knownIds.has(v.providerVoiceId) && listed.findIndex((w) => w.providerVoiceId === v.providerVoiceId) === i)
      .map((v) => ({
        provider: active.adapter.kind,
        providerVoiceId: v.providerVoiceId,
        label: v.name ?? v.providerVoiceId,
        sortOrder: next++,
        enabled: false,
      }));
    if (added.length > 0) await this.prisma.voice.createMany({ data: added });

    await this.audit.record({
      actorId: adminId,
      actorType: 'admin',
      action: 'voice.synced',
      entityType: 'Voice',
      after: { provider: active.adapter.kind, added: added.map((v) => v.providerVoiceId) },
    });
    return this.listForAdmin();
  }

  async update(id: string, change: { label?: string; enabled?: boolean }, adminId: string): Promise<Voice> {
    const row = await this.find(id);
    if (change.enabled === true && !row.sampleUrl) {
      throw appError(HttpStatus.CONFLICT, ErrorCode.CONFLICT, 'Make a sample before switching this voice on.');
    }
    const data: { label?: string; enabled?: boolean } = {};
    if (change.label !== undefined) data.label = change.label.trim();
    if (change.enabled !== undefined) data.enabled = change.enabled;
    const updated = await this.prisma.voice.update({ where: { id }, data });
    await this.audit.record({
      actorId: adminId,
      actorType: 'admin',
      action: 'voice.updated',
      entityType: 'Voice',
      entityId: id,
      before: { label: row.label, enabled: row.enabled },
      after: { label: updated.label, enabled: updated.enabled },
    });
    return updated;
  }

  /** [ids] must name every voice exactly once, top to bottom. */
  async reorder(ids: string[], adminId: string): Promise<Voice[]> {
    const all = await this.prisma.voice.findMany({});
    const known = new Set(all.map((v) => v.id));
    if (ids.length !== all.length || new Set(ids).size !== ids.length || ids.some((id) => !known.has(id))) {
      throw appError(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.VALIDATION_FAILED, 'Send every voice exactly once.');
    }
    await this.prisma.$transaction(
      ids.map((id, sortOrder) => this.prisma.voice.update({ where: { id }, data: { sortOrder } })),
    );
    await this.audit.record({
      actorId: adminId,
      actorType: 'admin',
      action: 'voice.reordered',
      entityType: 'Voice',
      after: { ids },
    });
    return this.listForAdmin();
  }

  /**
   * Speaks [SAMPLE_TEXT] in the voice, stores it, and replaces the old
   * sample. The owner's provider spend, never a user's credits. A refusal
   * leaves the old sample as it was; a failed delete of the old file is
   * only logged.
   */
  async makeSample(id: string, adminId: string): Promise<Voice> {
    const row = await this.find(id);
    // Taken before the row changes: the old file goes only once the new one is in place.
    const old = { storageId: row.sampleStorageId, key: row.sampleStorageKey };
    const active = await this.activeProvider();
    let audio: Buffer;
    try {
      audio = await active.adapter.synthesize({ text: SAMPLE_TEXT, voiceId: row.providerVoiceId }, active.apiKey);
    } catch (err) {
      throw providerFailure(err);
    }

    const store = await this.storage.getDefault();
    const storageKey = `${SAMPLE_PREFIX}${randomUUID()}.mp3`;
    await store.putObject(storageKey, audio, 'audio/mpeg');
    const updated = await this.prisma.voice.update({
      where: { id },
      data: { sampleStorageId: store.id, sampleStorageKey: storageKey, sampleUrl: store.getDeliveryUrl(storageKey) },
    });

    if (old.storageId && old.key) {
      try {
        await (await this.storage.get(old.storageId)).delete(old.key);
      } catch (err) {
        this.logger.warn(
          `Could not delete the old sample of voice ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    await this.audit.record({
      actorId: adminId,
      actorType: 'admin',
      action: 'voice.sample.made',
      entityType: 'Voice',
      entityId: id,
    });
    return updated;
  }

  /** The voice a job may speak in: switched on, or null. */
  voiceForJob(id: string): Promise<Voice | null> {
    return this.prisma.voice.findFirst({ where: { id, enabled: true } });
  }

  private async find(id: string): Promise<Voice> {
    const row = await this.prisma.voice.findUnique({ where: { id } });
    if (!row) throw appError(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'Voice not found.');
    return row;
  }

  private async activeProvider(): Promise<ActiveVoiceProvider> {
    const active = await this.credentials.getActiveTextToSpeech();
    if (!active) {
      throw appError(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.TTS_UNAVAILABLE,
        'Add an xAI key under Text to speech on the Providers page, and switch it on.',
      );
    }
    return active;
  }
}

/** A provider's refusal or outage, as the owner reads it. */
function providerFailure(err: unknown) {
  const message =
    err instanceof ProviderError ? err.message : 'The text-to-speech provider could not be reached. Try again.';
  return appError(HttpStatus.BAD_GATEWAY, ErrorCode.PROVIDER_FAILED, message);
}
