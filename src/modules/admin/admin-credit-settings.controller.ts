import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../../core/auth/current-user.decorator';
import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { RequirePermission } from '../../core/auth/permissions';
import { AccessTokenClaims } from '../auth/token.service';
import { CreditSettingsService } from '../credits/credit-settings.service';
import { UpdateCreditSettingsDto } from './dto/credit-admin.dto';

@Controller('api/admin/v1/credit-settings')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminCreditSettingsController {
  constructor(private readonly settings: CreditSettingsService) {}

  @Get()
  @RequirePermission('credits.manage')
  async get() {
    return { success: true as const, data: await this.settings.get() };
  }

  @Put()
  @RequirePermission('credits.manage')
  async update(@Body() dto: UpdateCreditSettingsDto, @CurrentUser() user: AccessTokenClaims) {
    return { success: true as const, data: await this.settings.update({ ...dto }, user.sub) };
  }
}
