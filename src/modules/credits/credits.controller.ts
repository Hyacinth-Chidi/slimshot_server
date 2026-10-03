import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';

import { CurrentAppUser } from '../accounts/current-app-user.decorator';
import { type AuthenticatedAppUser, UserAuthGuard } from '../accounts/user-auth.guard';
import { CreditsService } from './credits.service';
import { HistoryQueryDto, QuoteDto } from './dto/credits.dto';

@Controller('api/app/v1/credits')
@UseGuards(UserAuthGuard)
export class CreditsController {
  constructor(private readonly credits: CreditsService) {}

  @Post('quote')
  @HttpCode(200)
  async quote(@CurrentAppUser() user: AuthenticatedAppUser, @Body() dto: QuoteDto) {
    return { success: true as const, data: await this.credits.quote(user.id, dto.feature, dto.durationSeconds) };
  }

  @Get('history')
  async history(@CurrentAppUser() user: AuthenticatedAppUser, @Query() query: HistoryQueryDto) {
    return { success: true as const, data: await this.credits.history(user.id, query.cursor, query.limit) };
  }
}
