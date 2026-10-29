import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../../core/auth/current-user.decorator';
import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { RequirePermission } from '../../core/auth/permissions';
import { PrismaService } from '../../prisma/prisma.service';
import { AccessTokenClaims } from '../auth/token.service';
import { CreditSettingsService } from '../credits/credit-settings.service';
import { lastChangedByField } from './credit-settings-history';
import { UpdateCreditSettingsDto } from './dto/credit-admin.dto';

@Controller('api/admin/v1/credit-settings')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminCreditSettingsController {
  constructor(
    private readonly settings: CreditSettingsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @RequirePermission('credits.manage')
  async get() {
    const settings = await this.settings.get();
    return { success: true as const, data: { ...settings, lastChanged: await lastChangedByField(this.prisma) } };
  }

  @Put()
  @RequirePermission('credits.manage')
  async update(@Body() dto: UpdateCreditSettingsDto, @CurrentUser() user: AccessTokenClaims) {
    const settings = await this.settings.update({ ...dto }, user.sub);
    // Read after the save, so the change just made is the newest one.
    return { success: true as const, data: { ...settings, lastChanged: await lastChangedByField(this.prisma) } };
  }
}
