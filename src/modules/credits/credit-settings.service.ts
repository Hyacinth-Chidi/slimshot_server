import { Injectable } from '@nestjs/common';

import { AuditService } from '../../core/audit/audit.service';
import type { CreditSettings } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export type CreditSettingsPatch = Partial<Omit<CreditSettings, 'id' | 'updatedById' | 'updatedAt'>>;

const CACHE_MS = 30_000;

/** The one settings row the admin edits: every amount, cap and limit. */
@Injectable()
export class CreditSettingsService {
  private cached?: { value: CreditSettings; expiresAt: number };

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(): Promise<CreditSettings> {
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached.value;
    const value = await this.prisma.creditSettings.findUniqueOrThrow({ where: { id: 'default' } });
    this.cached = { value, expiresAt: Date.now() + CACHE_MS };
    return value;
  }

  async update(patch: CreditSettingsPatch, adminId: string): Promise<CreditSettings> {
    const before = await this.get();
    const value = await this.prisma.creditSettings.update({
      where: { id: 'default' },
      data: { ...patch, updatedById: adminId },
    });
    this.cached = undefined;
    await this.audit.record({
      actorId: adminId,
      actorType: 'admin',
      action: 'credits.settings.updated',
      entityType: 'CreditSettings',
      entityId: 'default',
      before,
      after: value,
    });
    return value;
  }
}
