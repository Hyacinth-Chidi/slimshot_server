import { Injectable, Logger } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EnvelopeCryptoService } from '../crypto/envelope-crypto.service';
import { SETTINGS } from './setting-definitions';
import { SettingDefinition, validateSetting } from './setting-registry';

/** The shape written to SystemSetting for both create and update. */
type SettingRecord = {
  key: string;
  group: string;
  isSecret: boolean;
  updatedById: string;
  valueJson: Prisma.InputJsonValue | typeof Prisma.DbNull;
  valueCipher: Prisma.Bytes | null;
  keyVersion: number | null;
};

export interface MaskedSetting {
  key: string;
  group: string;
  type: string;
  isSecret: boolean;
  value: unknown;
  description?: string;
}

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private readonly cache = new Map<string, unknown>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: EnvelopeCryptoService,
  ) {}

  async get<T = unknown>(key: string): Promise<T> {
    if (this.cache.has(key)) return this.cache.get(key) as T;

    const def = this.definition(key);
    const row = await this.prisma.systemSetting.findUnique({ where: { key } });

    let value: unknown;
    if (!row) {
      value = def.default;
    } else if (def.secret) {
      value = row.valueCipher
        ? this.crypto.decrypt({
            cipher: Buffer.from(row.valueCipher),
            keyVersion: row.keyVersion ?? 1,
          })
        : def.default;
    } else {
      value = row.valueJson ?? def.default;
    }

    this.cache.set(key, value);
    return value as T;
  }

  async set(key: string, value: unknown, actorId: string): Promise<void> {
    const def = this.definition(key);
    const validated = validateSetting(def, value);

    const payload = def.secret
      ? this.sealed(validated)
      : {
          valueJson: validated as Prisma.InputJsonValue,
          valueCipher: null,
          keyVersion: null,
        };

    const record: SettingRecord = {
      key,
      group: def.group,
      isSecret: def.secret,
      updatedById: actorId,
      ...payload,
    };

    await this.prisma.systemSetting.upsert({
      where: { key },
      create: record,
      update: record,
    });

    this.invalidate(key);
    this.logger.log(`setting ${key} updated by ${actorId}`);
  }

  async getMaskedGroup(group: string): Promise<MaskedSetting[]> {
    const defs = [...SETTINGS.values()].filter((d) => d.group === group);
    return Promise.all(
      defs.map(async (def) => {
        const raw = await this.get(def.key);
        return {
          key: def.key,
          group: def.group,
          type: def.type,
          isSecret: def.secret,
          description: def.description,
          value: def.secret ? this.crypto.mask(String(raw)) : raw,
        };
      }),
    );
  }

  /** Called by the Redis pub/sub subscriber so every instance drops its copy. */
  invalidate(key: string): void {
    this.cache.delete(key);
  }

  private sealed(
    value: unknown,
  ): Pick<SettingRecord, 'valueJson' | 'valueCipher' | 'keyVersion'> {
    const sealed = this.crypto.encrypt(String(value));
    return {
      // A secret has no JSON value at all — Prisma.DbNull sets the column to a
      // real SQL NULL (Prisma.JsonNull would instead store a JSON "null" literal).
      valueJson: Prisma.DbNull,
      // Buffer<ArrayBufferLike> vs. Prisma's Bytes (Uint8Array<ArrayBuffer>): a
      // Buffer produced by node:crypto is always backed by a real ArrayBuffer,
      // never a SharedArrayBuffer, so this slice is a safe, cheap view — not a copy.
      valueCipher: sealed.cipher.subarray(0) as Prisma.Bytes,
      keyVersion: sealed.keyVersion,
    };
  }

  private definition(key: string): SettingDefinition {
    const def = SETTINGS.get(key);
    if (!def) throw new Error(`Unknown setting key: ${key}`);
    return def;
  }
}
