import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';

import { RateLimiter } from '../../core/rate-limit/rate-limiter';
import { AccountDeletionService } from './account-deletion.service';
import { ClaimService } from './claim.service';
import { CurrentAppUser } from './current-app-user.decorator';
import { ClaimDto, DeleteMeDto, UsernameDto } from './dto/me.dto';
import { MeService } from './me.service';
import { type AuthenticatedAppUser, UserAuthGuard } from './user-auth.guard';
import { UsernameService } from './username.service';

@Controller('api/app/v1')
@UseGuards(UserAuthGuard)
export class MeController {
  constructor(
    private readonly me: MeService,
    private readonly usernames: UsernameService,
    private readonly claims: ClaimService,
    private readonly limiter: RateLimiter,
    private readonly deletion: AccountDeletionService,
  ) {}

  @Get('me')
  async view(@CurrentAppUser() user: AuthenticatedAppUser) {
    return { success: true as const, data: await this.me.view(user.id) };
  }

  @Get('usernames/:name/availability')
  async availability(@CurrentAppUser() user: AuthenticatedAppUser, @Param('name') name: string) {
    await this.limiter.hit(`username:${user.id}`, 60, 60);
    return { success: true as const, data: await this.usernames.check(name, user.id) };
  }

  @Patch('me/username')
  async changeUsername(@CurrentAppUser() user: AuthenticatedAppUser, @Body() dto: UsernameDto) {
    await this.usernames.change(user.id, dto.username);
    return { success: true as const, data: await this.me.view(user.id) };
  }

  @Post('me/claim')
  @HttpCode(200)
  async claim(@CurrentAppUser() user: AuthenticatedAppUser, @Body() dto: ClaimDto) {
    return { success: true as const, data: await this.claims.claim(user, dto) };
  }

  @Delete('me')
  async remove(@CurrentAppUser() user: AuthenticatedAppUser, @Body() _dto: DeleteMeDto) {
    await this.deletion.deleteAccount(user.id, { type: 'user', id: user.id });
    return { success: true as const, data: { deleted: true } };
  }
}
