import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../../core/auth/current-user.decorator';
import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { RequirePermission } from '../../core/auth/permissions';
import { AccessTokenClaims } from '../auth/token.service';
import { PushService } from '../push/push.service';
import { SendPushDto } from './dto/push-admin.dto';

/** Push notifications to the app, for the owner alone. */
@Controller('api/admin/v1/notifications')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminNotificationsController {
  constructor(private readonly push: PushService) {}

  @Get()
  @RequirePermission('notifications.send')
  async overview() {
    return { success: true as const, data: await this.push.overview() };
  }

  /** Queued, not awaited: a large send takes a while. The page polls the list until it ends. */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('notifications.send')
  async send(@Body() dto: SendPushDto, @CurrentUser() user: AccessTokenClaims) {
    const input = { title: dto.title, body: dto.body, ...(dto.user ? { user: dto.user } : {}) };
    return { success: true as const, data: await this.push.send(input, { id: user.sub }) };
  }
}
