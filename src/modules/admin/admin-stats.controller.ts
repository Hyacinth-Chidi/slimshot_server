import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { RequirePermission } from '../../core/auth/permissions';
import { StatsService } from './stats.service';

@Controller('api/admin/v1/stats')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminStatsController {
  constructor(private readonly stats: StatsService) {}

  @Get('summary')
  @RequirePermission('asset.read')
  async summary() {
    return { success: true as const, data: await this.stats.summary() };
  }

  @Get('uploads-over-time')
  @RequirePermission('asset.read')
  async uploads(
    @Query('days', new DefaultValuePipe(30), ParseIntPipe) days: number,
  ) {
    return { success: true as const, data: await this.stats.uploadsOverTime(days) };
  }
}
