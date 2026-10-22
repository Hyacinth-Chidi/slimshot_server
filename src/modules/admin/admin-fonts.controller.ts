import { Body, Controller, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../../core/auth/current-user.decorator';
import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { RequirePermission } from '../../core/auth/permissions';
import { AssetService } from '../assets/asset.service';
import { AccessTokenClaims } from '../auth/token.service';
import { FontsService } from '../fonts/fonts.service';
import { ReorderFontsDto, UpdateFontDto } from './dto/font-admin.dto';

/** What fonts need beyond the generic asset routes: order, licence, and the legacy checklist. */
@Controller('api/admin/v1/fonts')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminFontsController {
  constructor(
    private readonly fonts: FontsService,
    private readonly assets: AssetService,
  ) {}

  @Get('order')
  @RequirePermission('asset.read')
  async order() {
    return { success: true as const, data: await this.fonts.order() };
  }

  @Post('reorder')
  @HttpCode(204)
  @RequirePermission('asset.update')
  async reorder(@Body() dto: ReorderFontsDto, @CurrentUser() user: AccessTokenClaims): Promise<void> {
    await this.fonts.reorder(dto.ids, user.sub);
  }

  @Get('legacy-families')
  @RequirePermission('asset.read')
  async legacyFamilies() {
    return { success: true as const, data: await this.fonts.legacyFamilies() };
  }

  @Patch(':id')
  @RequirePermission('asset.update')
  async update(@Param('id') id: string, @Body() dto: UpdateFontDto, @CurrentUser() user: AccessTokenClaims) {
    await this.fonts.updateLicense(id, dto.license, user.sub);
    return { success: true as const, data: await this.assets.getById(id) };
  }
}
