import { Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { CurrentAppUser } from '../accounts/current-app-user.decorator';
import { type AuthenticatedAppUser, UserAuthGuard } from '../accounts/user-auth.guard';
import { AdSessionsService } from './ad-sessions.service';
import { DailyRewardService } from './daily-reward.service';

@Controller('api/app/v1/rewards')
export class RewardsController {
  constructor(
    private readonly sessions: AdSessionsService,
    private readonly daily: DailyRewardService,
  ) {}

  /** Whether daily credits are on, how many, and when the next claim opens (null: now). */
  @Get('daily')
  @UseGuards(UserAuthGuard)
  async dailyStatus(@CurrentAppUser() user: AuthenticatedAppUser) {
    return { success: true as const, data: await this.daily.status(user.id) };
  }

  @Post('daily/claim')
  @HttpCode(200)
  @UseGuards(UserAuthGuard)
  async claimDaily(@CurrentAppUser() user: AuthenticatedAppUser) {
    return { success: true as const, data: await this.daily.claim(user) };
  }

  @Post('ads/session')
  @HttpCode(200)
  @UseGuards(UserAuthGuard)
  async start(@CurrentAppUser() user: AuthenticatedAppUser) {
    return { success: true as const, data: await this.sessions.start(user) };
  }

  @Get('ads/session/:nonce')
  @UseGuards(UserAuthGuard)
  async status(@CurrentAppUser() user: AuthenticatedAppUser, @Param('nonce') nonce: string) {
    return { success: true as const, data: await this.sessions.status(user, nonce) };
  }

  /** Called by Google, not the app. The signature covers the raw query string, so it is passed on untouched. */
  @Get('admob/ssv')
  async admobCallback(@Req() req: Request) {
    const url = req.originalUrl;
    const q = url.indexOf('?');
    await this.sessions.handleCallback(q >= 0 ? url.slice(q + 1) : '');
    return { success: true as const, data: { received: true } };
  }
}
