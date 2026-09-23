import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { RequirePermission } from '../../core/auth/permissions';
import { PrismaService } from '../../prisma/prisma.service';

const MAX_LIMIT = 100;

@Controller('api/admin/v1/audit-logs')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminAuditController {
  constructor(private readonly prisma: PrismaService) {}

  // Read-only by design. There is deliberately no delete handler at any
  // permission level: an audit log an admin can erase is not an audit log.
  @Get()
  @RequirePermission('audit.read')
  async list(
    @Query('actorId') actorId?: string,
    @Query('action') action?: string,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const take = Math.min(Number(limit) || 25, MAX_LIMIT);

    const rows = await this.prisma.auditLog.findMany({
      where: {
        ...(actorId ? { actorId } : {}),
        ...(action ? { action } : {}),
        ...(entityType ? { entityType } : {}),
        ...(entityId ? { entityId } : {}),
      },
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { createdAt: 'desc' },
    });

    return {
      success: true as const,
      data: rows,
      meta: {
        nextCursor: rows.length === take ? rows[rows.length - 1].id : null,
      },
    };
  }
}
