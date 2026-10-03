import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { RequirePermission } from '../../core/auth/permissions';
import { AdminUsersService } from './admin-users.service';
import { CreditStatsQueryDto } from './dto/user-admin.dto';

@Controller('api/admin/v1/stats/credits')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminCreditStatsController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  @RequirePermission('users.read')
  async stats(@Query() query: CreditStatsQueryDto) {
    return { success: true as const, data: await this.users.creditStats(query.days) };
  }
}
