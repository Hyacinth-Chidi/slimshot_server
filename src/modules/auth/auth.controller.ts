import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../../core/auth/current-user.decorator';
import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { AccessTokenClaims } from './token.service';

interface RequestLike {
  ip?: string;
  headers: Record<string, string | undefined>;
}

@Controller('api/admin/v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: RequestLike) {
    return { success: true as const, data: await this.auth.login(dto, ctx(req)) };
  }

  @Post('refresh')
  async refresh(@Body() dto: RefreshDto, @Req() req: RequestLike) {
    return { success: true as const, data: await this.auth.refresh(dto, ctx(req)) };
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  async logout(@Body() dto: RefreshDto) {
    await this.auth.logout(dto.refreshToken);
    return { success: true as const, data: { loggedOut: true } };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: AccessTokenClaims) {
    return { success: true as const, data: await this.auth.me(user.sub) };
  }
}

function ctx(req: RequestLike) {
  return { ip: req.ip, userAgent: req.headers['user-agent'] };
}
