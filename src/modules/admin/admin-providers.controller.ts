import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';

import { CurrentUser } from '../../core/auth/current-user.decorator';
import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { RequirePermission } from '../../core/auth/permissions';
import { AccessTokenClaims } from '../auth/token.service';
import { CapabilityDto } from '../providers/dto/capability.dto';
import { SetProviderKeyDto } from '../providers/dto/set-provider-key.dto';
import { ProviderCredentialsService } from '../providers/provider-credentials.service';
import { assertCapability, assertProvider } from '../providers/provider-params';

@Controller('api/admin/v1/providers')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminProvidersController {
  constructor(private readonly credentials: ProviderCredentialsService) {}

  @Get()
  @RequirePermission('providers.manage')
  async list(@Query('capability') capability: string | undefined) {
    return {
      success: true as const,
      data: await this.credentials.list(assertCapability(capability)),
    };
  }

  @Put(':provider/key')
  @RequirePermission('providers.manage')
  async setKey(
    @Param('provider') provider: string,
    @Body() dto: SetProviderKeyDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    await this.credentials.setKey(assertProvider(provider), dto.capability, dto.apiKey, user.sub);
    return { success: true as const, data: { configured: true } };
  }

  @Delete(':provider/key')
  @RequirePermission('providers.manage')
  async removeKey(
    @Param('provider') provider: string,
    @Query('capability') capability: string | undefined,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    await this.credentials.removeKey(
      assertProvider(provider),
      assertCapability(capability),
      user.sub,
    );
    return { success: true as const, data: { configured: false } };
  }

  @Post(':provider/activate')
  @HttpCode(200)
  @RequirePermission('providers.manage')
  async activate(
    @Param('provider') provider: string,
    @Body() dto: CapabilityDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return {
      success: true as const,
      data: await this.credentials.activate(assertProvider(provider), dto.capability, user.sub),
    };
  }

  @Post(':provider/deactivate')
  @HttpCode(200)
  @RequirePermission('providers.manage')
  async deactivate(
    @Param('provider') provider: string,
    @Body() dto: CapabilityDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return {
      success: true as const,
      data: await this.credentials.deactivate(assertProvider(provider), dto.capability, user.sub),
    };
  }

  @Post(':provider/test')
  @HttpCode(200)
  @RequirePermission('providers.manage')
  async test(@Param('provider') provider: string, @Body() dto: CapabilityDto) {
    return {
      success: true as const,
      data: await this.credentials.test(assertProvider(provider), dto.capability),
    };
  }
}
