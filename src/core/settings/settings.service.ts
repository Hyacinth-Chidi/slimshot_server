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

  /**
   * Is this setting populated with a value that would satisfy its own definition?
   *
   * Exists because `get` THROWS for a setting that declares a `minLength` and is
   * unset — which is correct for callers about to use the value, but makes it
   * impossible to ask "does this exist yet?". Bootstrap needs exactly that
   * question: it generates `auth.jwtAccessSecret` when absent, and using `get`
   * to detect absence meant the check could not survive the case it detects.
   */
  async isConfigured(key: string): Promise<boolean> {
    try {
      const value = await this.get(key);
      return typeof value === 'string' ? value.length > 0 : value !== undefined;
    } catch {
      return false;
    }
  }

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

    // A definition with a minLength is security-relevant (e.g. a signing secret).
    // Returning the empty default would let a caller sign with no secret at all.
    if (
      def.minLength !== undefined &&
      (typeof value !== 'string' || value.length < def.minLength)
    ) {
      throw new Error(
        `${key} is unset or too short (needs >= ${def.minLength} characters). ` +
          `It must be generated or configured before use.`,
      );
    }

    // Guard against a caller's generic disagreeing with the declared type.
    const actual = Array.isArray(value) ? 'string[]' : typeof value;
    const expected =
      def.type === 'int' ? 'number' : def.type === 'json' ? 'object' : def.type;
    if (actual !== expected) {
      throw new Error(
        `${key}: stored value is ${actual} but the definition declares ${def.type}`,
      );
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

  /**
   * Returns a secret's true value. This is the ONLY path that returns decrypted
   * plaintext to a caller, and it is deliberately a separate method rather than
   * a flag on getMaskedGroup: a boolean can default wrong, be forwarded from a
   * query string, or be set by a caller that did not intend it. A separate
   * method cannot be reached by accident.
   *
   * Callers MUST gate this behind re-authentication. It has exactly one caller
   * (AdminSettingsController.reveal) and a test asserts that.
   */
  async revealSecret(key: string): Promise<string> {
    const def = this.definition(key);
    if (!def.secret) {
      throw new Error(`${key} is not a secret setting; use get() instead.`);
    }
    return this.get<string>(key);
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
