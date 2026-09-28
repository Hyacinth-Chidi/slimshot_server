import { ConflictException, Injectable, UnprocessableEntityException } from '@nestjs/common';

import { AuditService } from '../../core/audit/audit.service';
import { EnvelopeCryptoService } from '../../core/crypto/envelope-crypto.service';
import { ProviderCapability, ProviderKind } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { ProviderRegistry } from './provider.registry';
import { PROVIDER_NAMES, type KeyCheck, type SpeechToTextProvider } from './speech-to-text.provider';

export interface ProviderStatus {
  provider: ProviderKind;
  capability: ProviderCapability;
  configured: boolean;
  active: boolean;
  updatedAt: Date | null;
}

export interface ActiveProvider {
  adapter: SpeechToTextProvider;
  apiKey: string;
}

const ACTIVE_CACHE_MS = 60_000;
const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 512;

/**
 * Owns ProviderCredential. Keys go in encrypted and only come out decrypted
 * for a provider call or a key test; nothing here returns one to a caller
 * outside the server.
 */
@Injectable()
export class ProviderCredentialsService {
  // Decrypting per caption job would be a DB read plus AES per job. Every
  // change below clears this, so a replaced key or a switched provider is
  // used by the very next job.
  private readonly activeCache = new Map<
    ProviderCapability,
    { value: ActiveProvider | null; expiresAt: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: EnvelopeCryptoService,
    private readonly registry: ProviderRegistry,
    private readonly audit: AuditService,
  ) {}

  async list(capability: ProviderCapability): Promise<ProviderStatus[]> {
    const rows = await this.prisma.providerCredential.findMany({
      where: { capability },
      select: { provider: true, isActive: true, updatedAt: true },
    });
    return Object.values(ProviderKind).map((provider) => {
      const row = rows.find((r) => r.provider === provider);
      return {
        provider,
        capability,
        configured: row !== undefined,
        active: row?.isActive ?? false,
        updatedAt: row?.updatedAt ?? null,
      };
    });
  }

  async setKey(
    provider: ProviderKind,
    capability: ProviderCapability,
    apiKey: string,
    adminId: string,
  ): Promise<void> {
    const key = apiKey.trim();
    if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH) {
      throw new UnprocessableEntityException(
        `apiKey must be ${MIN_KEY_LENGTH}–${MAX_KEY_LENGTH} characters.`,
      );
    }

    const sealed = this.crypto.encrypt(key);
    const row = await this.prisma.providerCredential.upsert({
      where: { provider_capability: { provider, capability } },
      create: {
        provider,
        capability,
        apiKeyCipher: sealed.cipher,
        keyVersion: sealed.keyVersion,
        updatedById: adminId,
      },
      update: { apiKeyCipher: sealed.cipher, keyVersion: sealed.keyVersion, updatedById: adminId },
      select: { id: true },
    });
    this.activeCache.clear();

    await this.audit.record({
      actorId: adminId,
      actorType: 'admin',
      action: 'provider.key.set',
      entityType: 'ProviderCredential',
      entityId: row.id,
      after: { provider, capability },
    });
  }

  async removeKey(
    provider: ProviderKind,
    capability: ProviderCapability,
    adminId: string,
  ): Promise<void> {
    const { count } = await this.prisma.providerCredential.deleteMany({
      where: { provider, capability },
    });
    this.activeCache.clear();
    if (count === 0) return;

    await this.audit.record({
      actorId: adminId,
      actorType: 'admin',
      action: 'provider.key.removed',
      entityType: 'ProviderCredential',
      after: { provider, capability },
    });
  }

  async activate(
    provider: ProviderKind,
    capability: ProviderCapability,
    adminId: string,
  ): Promise<ProviderStatus[]> {
    const row = await this.prisma.providerCredential.findUnique({
      where: { provider_capability: { provider, capability } },
      select: { id: true, isActive: true },
    });
    if (!row) {
      throw new ConflictException(
        `Add an API key for ${PROVIDER_NAMES[provider]} before making it active.`,
      );
    }

    if (!row.isActive) {
      // Deactivate first, in the same transaction: the partial unique index
      // refuses two active rows even for an instant.
      await this.prisma.$transaction([
        this.prisma.providerCredential.updateMany({
          where: { capability, isActive: true },
          data: { isActive: false, updatedById: adminId },
        }),
        this.prisma.providerCredential.update({
          where: { id: row.id },
          data: { isActive: true, updatedById: adminId },
        }),
      ]);
      this.activeCache.clear();

      await this.audit.record({
        actorId: adminId,
        actorType: 'admin',
        action: 'provider.activated',
        entityType: 'ProviderCredential',
        entityId: row.id,
        after: { provider, capability },
      });
    }

    return this.list(capability);
  }

  async deactivate(
    provider: ProviderKind,
    capability: ProviderCapability,
    adminId: string,
  ): Promise<ProviderStatus[]> {
    const { count } = await this.prisma.providerCredential.updateMany({
      where: { provider, capability, isActive: true },
      data: { isActive: false, updatedById: adminId },
    });

    if (count > 0) {
      this.activeCache.clear();
      await this.audit.record({
        actorId: adminId,
        actorType: 'admin',
        action: 'provider.deactivated',
        entityType: 'ProviderCredential',
        after: { provider, capability },
      });
    }

    return this.list(capability);
  }

  async test(provider: ProviderKind, capability: ProviderCapability): Promise<KeyCheck> {
    const row = await this.prisma.providerCredential.findUnique({
      where: { provider_capability: { provider, capability } },
      select: { apiKeyCipher: true, keyVersion: true },
    });
    if (!row) return { ok: false, message: `No key saved for ${PROVIDER_NAMES[provider]}.` };

    const apiKey = this.crypto.decrypt({ cipher: row.apiKeyCipher, keyVersion: row.keyVersion });
    return this.registry.speechToTextFor(provider).testKey(apiKey);
  }

  /** The provider caption jobs should use right now, or null when none is active. */
  async getActive(capability: ProviderCapability): Promise<ActiveProvider | null> {
    const cached = this.activeCache.get(capability);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const row = await this.prisma.providerCredential.findFirst({
      where: { capability, isActive: true },
      select: { provider: true, apiKeyCipher: true, keyVersion: true },
    });
    const value = row
      ? {
          adapter: this.registry.speechToTextFor(row.provider),
          apiKey: this.crypto.decrypt({ cipher: row.apiKeyCipher, keyVersion: row.keyVersion }),
        }
      : null;

    this.activeCache.set(capability, { value, expiresAt: Date.now() + ACTIVE_CACHE_MS });
    return value;
  }
}
