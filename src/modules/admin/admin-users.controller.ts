import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../../core/auth/current-user.decorator';
import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { RequirePermission } from '../../core/auth/permissions';
import { AccessTokenClaims } from '../auth/token.service';
import { AdminUsersService } from './admin-users.service';
import { AdjustCreditsDto, PageQueryDto, ReasonDto, SearchUsersQueryDto } from './dto/user-admin.dto';

/** App users (people signed in to the mobile app), not dashboard admins. */
@Controller('api/admin/v1/users')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  @RequirePermission('users.read')
  async search(@Query() query: SearchUsersQueryDto) {
    return { success: true as const, data: await this.users.search(query.q, query.cursor, query.limit) };
  }

  @Get(':id')
  @RequirePermission('users.read')
  async detail(@Param('id') id: string) {
    return { success: true as const, data: await this.users.detail(id) };
  }

  @Get(':id/ledger')
  @RequirePermission('users.read')
  async ledger(@Param('id') id: string, @Query() query: PageQueryDto) {
    return { success: true as const, data: await this.users.ledgerOf(id, query.cursor, query.limit) };
  }

  @Post(':id/adjustments')
  @HttpCode(200)
  @RequirePermission('users.manage')
  async adjust(@Param('id') id: string, @Body() dto: AdjustCreditsDto, @CurrentUser() user: AccessTokenClaims) {
    return { success: true as const, data: await this.users.adjust(id, dto.amount, dto.reason, user.sub) };
  }

  @Post(':id/suspend')
  @HttpCode(200)
  @RequirePermission('users.manage')
  async suspend(@Param('id') id: string, @Body() dto: ReasonDto, @CurrentUser() user: AccessTokenClaims) {
    return { success: true as const, data: await this.users.suspend(id, dto.reason, user.sub) };
  }

  @Post(':id/unsuspend')
  @HttpCode(200)
  @RequirePermission('users.manage')
  async unsuspend(@Param('id') id: string, @CurrentUser() user: AccessTokenClaims) {
    return { success: true as const, data: await this.users.unsuspend(id, user.sub) };
  }

  @Delete(':id')
  @RequirePermission('users.manage')
  async remove(@Param('id') id: string, @Body() dto: ReasonDto, @CurrentUser() user: AccessTokenClaims) {
    await this.users.remove(id, dto.reason, user.sub);
    return { success: true as const, data: { deleted: true } };
  }
}
