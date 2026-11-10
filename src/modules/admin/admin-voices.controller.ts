import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../../core/auth/current-user.decorator';
import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { RequirePermission } from '../../core/auth/permissions';
import { AccessTokenClaims } from '../auth/token.service';
import { VoicesService } from '../voices/voices.service';
import { ReorderVoicesDto, UpdateVoiceDto } from './dto/voice-admin.dto';

/**
 * The voices the app offers for text to speech. Under `providers.manage`:
 * voices are the provider's, and a sample spends its key. Contract:
 * docs/admin-voices-api.md.
 */
@Controller('api/admin/v1/voices')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminVoicesController {
  constructor(private readonly voices: VoicesService) {}

  @Get()
  @RequirePermission('providers.manage')
  async list() {
    return { success: true as const, data: await this.voices.listForAdmin() };
  }

  @Post('sync')
  @HttpCode(200)
  @RequirePermission('providers.manage')
  async sync(@CurrentUser() user: AccessTokenClaims) {
    return { success: true as const, data: await this.voices.sync(user.sub) };
  }

  @Put('order')
  @RequirePermission('providers.manage')
  async reorder(@Body() dto: ReorderVoicesDto, @CurrentUser() user: AccessTokenClaims) {
    return { success: true as const, data: await this.voices.reorder(dto.ids, user.sub) };
  }

  @Patch(':id')
  @RequirePermission('providers.manage')
  async update(@Param('id') id: string, @Body() dto: UpdateVoiceDto, @CurrentUser() user: AccessTokenClaims) {
    return {
      success: true as const,
      data: await this.voices.update(id, { label: dto.label, enabled: dto.enabled }, user.sub),
    };
  }

  @Post(':id/sample')
  @HttpCode(200)
  @RequirePermission('providers.manage')
  async makeSample(@Param('id') id: string, @CurrentUser() user: AccessTokenClaims) {
    return { success: true as const, data: await this.voices.makeSample(id, user.sub) };
  }
}
