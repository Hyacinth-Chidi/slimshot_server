import { Inject, Injectable } from '@nestjs/common';

import { cloudinaryConfig, type CloudinaryEnvConfig } from '../../config';
import { PrismaService } from '../../prisma/prisma.service';
import { CloudinaryAdapter } from './adapters/cloudinary.adapter';
import { StorageProviderAdapter } from './storage-adapter.interface';

/** Provider rows are identity only (what asset files point at); credentials come from env. */
interface ProviderRow {
  id: string;
  kind: string;
}

const IDENTITY = { id: true, kind: true } as const;

@Injectable()
export class StorageRegistry {
  private readonly adapters = new Map<string, StorageProviderAdapter>();
  private defaultId?: string;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(cloudinaryConfig.KEY) private readonly cloudinary: CloudinaryEnvConfig,
  ) {}

  async getDefault(): Promise<StorageProviderAdapter> {
    if (this.defaultId) {
      const cached = this.adapters.get(this.defaultId);
      if (cached) return cached;
    }

    const row = (await this.prisma.storageProvider.findFirst({
      where: { isDefault: true, isActive: true },
      select: IDENTITY,
    })) as ProviderRow | null;

    if (!row) {
      throw new Error('No default storage provider is configured. Run `npx prisma db seed`.');
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
      select: IDENTITY,
    })) as ProviderRow | null;

    if (!row) throw new Error(`Storage provider not found: ${id}`);

    const adapter = this.build(row);
    this.adapters.set(id, adapter);
    return adapter;
  }

  /** Drop cached clients (used by tests; config only changes on restart). */
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
    switch (row.kind) {
      case 'cloudinary':
        return new CloudinaryAdapter(row.id, this.cloudinary);
      default:
        throw new Error(`Unsupported storage kind: ${row.kind}`);
    }
  }
}
