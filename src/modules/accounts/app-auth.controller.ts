import { Body, Controller, HttpCode, Ip, Post } from '@nestjs/common';

import { AccountsService } from './accounts.service';
import { AppRefreshDto, EmailStartDto, EmailVerifyDto, GoogleSignInDto } from './dto/sign-in.dto';

@Controller('api/app/v1/auth')
export class AppAuthController {
  constructor(private readonly accounts: AccountsService) {}

  @Post('google')
  @HttpCode(200)
  async google(@Body() dto: GoogleSignInDto, @Ip() ip: string) {
    return { success: true as const, data: await this.accounts.signInWithGoogle(dto.idToken, dto.deviceToken, ip) };
  }

  @Post('email/start')
  @HttpCode(200)
  async startEmail(@Body() dto: EmailStartDto, @Ip() ip: string) {
    return { success: true as const, data: await this.accounts.startEmail(dto.email, dto.deviceToken, ip) };
  }

  @Post('email/verify')
  @HttpCode(200)
  async verifyEmail(@Body() dto: EmailVerifyDto, @Ip() ip: string) {
    return {
      success: true as const,
      data: await this.accounts.verifyEmail(dto.email, dto.code, dto.deviceToken, ip),
    };
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() dto: AppRefreshDto) {
    return { success: true as const, data: await this.accounts.refresh(dto.refreshToken) };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Body() dto: AppRefreshDto) {
    await this.accounts.logout(dto.refreshToken);
    return { success: true as const, data: { loggedOut: true } };
  }
}
