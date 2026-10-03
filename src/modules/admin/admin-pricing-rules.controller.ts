import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../../core/auth/current-user.decorator';
import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { RequirePermission } from '../../core/auth/permissions';
import { AccessTokenClaims } from '../auth/token.service';
import { PricingService } from '../credits/pricing.service';
import { CreatePricingRuleDto, PricingRulesQueryDto } from './dto/credit-admin.dto';

@Controller('api/admin/v1/pricing-rules')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminPricingRulesController {
  constructor(private readonly pricing: PricingService) {}

  @Get()
  @RequirePermission('credits.manage')
  async list(@Query() query: PricingRulesQueryDto) {
    return { success: true as const, data: await this.pricing.listRules(query.feature) };
  }

  @Post()
  @RequirePermission('credits.manage')
  async create(@Body() dto: CreatePricingRuleDto, @CurrentUser() user: AccessTokenClaims) {
    return { success: true as const, data: await this.pricing.createRule(dto, user.sub) };
  }

  @Post(':id/activate')
  @HttpCode(200)
  @RequirePermission('credits.manage')
  async activate(@Param('id') id: string, @CurrentUser() user: AccessTokenClaims) {
    return { success: true as const, data: await this.pricing.activate(id, user.sub) };
  }
}
