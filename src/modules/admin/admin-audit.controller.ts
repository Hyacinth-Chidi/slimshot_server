import {
  Controller,
  Get,
  Query,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { RequirePermission } from '../../core/auth/permissions';
import { PrismaService } from '../../prisma/prisma.service';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;
const MIN_LIMIT = 1;

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
    const take = parseLimit(limit);

    const rows = await this.prisma.auditLog.findMany({
      where: {
        ...(actorId ? { actorId } : {}),
        ...(action ? { action } : {}),
        ...(entityType ? { entityType } : {}),
        ...(entityId ? { entityId } : {}),
      },
      // One row beyond the page, purely to learn whether a next page exists.
      // Comparing rows.length to take instead reports a cursor whenever a page
      // happens to be exactly full, and following it yields an empty page.
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      // `createdAt` alone is not unique, and a burst of audit writes lands
      // several rows in the same millisecond. A cursor over a non-total order
      // silently skips or repeats rows at the page boundary, so `id` breaks
      // the tie.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;

    return {
      success: true as const,
      data: page,
      meta: {
        nextCursor: hasMore ? page[page.length - 1].id : null,
      },
    };
  }
}

/**
 * `Math.min(Number(limit) || 25, MAX)` let `limit=-5` through to Prisma, which
 * rejects a negative take as a 500 for what is only a malformed query string.
 * Garbage is refused outright rather than quietly becoming the default, so a
 * client sending `limit=abc` learns its request was wrong instead of getting a
 * page size it never asked for.
 */
function parseLimit(limit?: string): number {
  if (limit === undefined || limit === '') return DEFAULT_LIMIT;

  const parsed = Number(limit);
  if (!Number.isInteger(parsed)) {
    throw new UnprocessableEntityException(
      `limit must be a whole number between ${MIN_LIMIT} and ${MAX_LIMIT}.`,
    );
  }

  return Math.min(Math.max(parsed, MIN_LIMIT), MAX_LIMIT);
}
