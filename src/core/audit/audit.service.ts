import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

export interface AuditEntry {
  actorId?: string;
  actorType: 'admin' | 'system';
  action: string;
  entityType: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
  userAgent?: string;
}

const SECRET_FIELD = /secret|password|token|apikey|api_key|credential/i;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorId: entry.actorId ?? null,
          actorType: entry.actorType,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId ?? null,
          before: redact(entry.before) as never,
          after: redact(entry.after) as never,
          ip: entry.ip ?? null,
          userAgent: entry.userAgent ?? null,
        },
      });
    } catch (error) {
      // An audit failure must never take down the operation being audited.
      this.logger.error(`audit write failed for ${entry.action}: ${String(error)}`);
    }
  }
}

function redact(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      SECRET_FIELD.test(k) ? '[redacted]' : redact(v),
    ]),
  );
}
