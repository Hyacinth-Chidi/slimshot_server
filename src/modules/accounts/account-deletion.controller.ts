import { Body, Controller, HttpCode, Ip, Post } from '@nestjs/common';

import { AccountDeletionService } from './account-deletion.service';
import { DeletionConfirmDto, DeletionStartDto } from './dto/deletion.dto';

/** Deletion without the app (Google Play requirement), used by the page at /account-deletion. */
@Controller('api/app/v1/account-deletion')
export class AccountDeletionController {
  constructor(private readonly deletion: AccountDeletionService) {}

  @Post('start')
  @HttpCode(200)
  async start(@Body() dto: DeletionStartDto, @Ip() ip: string) {
    return { success: true as const, data: await this.deletion.requestWebDeletion(dto.email, ip) };
  }

  @Post('confirm')
  @HttpCode(200)
  async confirm(@Body() dto: DeletionConfirmDto) {
    await this.deletion.confirmWebDeletion(dto.email, dto.code);
    return { success: true as const, data: { deleted: true } };
  }
}
