import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { CurrentUser } from '../../core/auth/current-user.decorator';
import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { RequirePermission } from '../../core/auth/permissions';
import { SettingsService } from '../../core/settings/settings.service';
import { AccessTokenClaims } from '../auth/token.service';
import { RevealSecretDto } from './dto/reveal-secret.dto';
import { UpdateSettingDto } from './dto/update-setting.dto';
import { SettingsAdminService } from './settings-admin.service';

interface RequestLike {
  ip?: string;
  headers: Record<string, string | undefined>;
}

@Controller('api/admin/v1/settings')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminSettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly admin: SettingsAdminService,
  ) {}

  @Get()
  @RequirePermission('settings.read')
  // Only masked values are returned here, but a mask still reveals up to a
  // third of a secret (e.g. a 43-char Redis URL masks to
  // 'redis://••••6379'), which should not sit in a shared proxy cache.
  @Header('Cache-Control', 'no-store')
  async list(@Query('group') group = 'upload') {
    return {
      success: true as const,
      data: await this.settings.getMaskedGroup(group),
    };
  }

  @Put(':key')
  @RequirePermission('settings.write')
  async update(
    @Param('key') key: string,
    @Body() dto: UpdateSettingDto,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: RequestLike,
  ) {
    await this.admin.update(
      key,
      dto.value,
      user.sub,
      { password: dto.password, grant: dto.grant },
      ctx(req),
    );
    return { success: true as const, data: { updated: true } };
  }

  // The ONLY caller of SettingsService.revealSecret. A test asserts that.
  @Post(':key/reveal')
  @RequirePermission('settings.write')
  @Header('Cache-Control', 'no-store')
  async reveal(
    @Param('key') key: string,
    @Body() dto: RevealSecretDto,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: RequestLike,
  ) {
    return {
      success: true as const,
      data: await this.admin.reveal(key, user.sub, dto.password, ctx(req)),
    };
  }
}

function ctx(req: RequestLike) {
  return { ip: req.ip, userAgent: req.headers['user-agent'] };
}
