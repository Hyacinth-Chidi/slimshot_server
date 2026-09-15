import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { EnvelopeCryptoService } from '../crypto/envelope-crypto.service';
import { CloudinaryAdapter } from './adapters/cloudinary.adapter';
import {
  CloudinaryConfig,
  StorageProviderAdapter,
} from './storage-adapter.interface';

interface ProviderRow {
  id: string;
  kind: string;
  configCipher: Uint8Array;
  keyVersion: number;
}

@Injectable()
export class StorageRegistry {
  private readonly adapters = new Map<string, StorageProviderAdapter>();
  private defaultId?: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: EnvelopeCryptoService,
  ) {}

  async getDefault(): Promise<StorageProviderAdapter> {
    if (this.defaultId) {
      const cached = this.adapters.get(this.defaultId);
      if (cached) return cached;
    }

    const row = (await this.prisma.storageProvider.findFirst({
      where: { isDefault: true, isActive: true },
    })) as ProviderRow | null;

    if (!row) {
      throw new Error(
        'No default storage provider is configured. Create one via the admin API.',
      );
    }

    const adapter = this.build(row);
    this.defaultId = row.id;
    this.adapters.set(row.id, adapter);
    return adapter;
  }

  async get(id: string): Promise<StorageProviderAdapter> {
    const cached = this.adapters.get(id);
    if (cached) return cached;

    const row = (await this.prisma.storageProvider.findUnique({
      where: { id },
    })) as ProviderRow | null;

    if (!row) throw new Error(`Storage provider not found: ${id}`);

    const adapter = this.build(row);
    this.adapters.set(id, adapter);
    return adapter;
  }

  /** Drop cached clients after an admin edits provider config. */
  invalidate(id?: string): void {
    if (id) {
      this.adapters.delete(id);
      if (this.defaultId === id) this.defaultId = undefined;
      return;
    }
    this.adapters.clear();
    this.defaultId = undefined;
  }

  private build(row: ProviderRow): StorageProviderAdapter {
    const json = this.crypto.decrypt({
      cipher: Buffer.from(row.configCipher),
      keyVersion: row.keyVersion,
    });

    switch (row.kind) {
      case 'cloudinary':
        return new CloudinaryAdapter(row.id, JSON.parse(json) as CloudinaryConfig);
      default:
        throw new Error(`Unsupported storage kind: ${row.kind}`);
    }
  }
}
