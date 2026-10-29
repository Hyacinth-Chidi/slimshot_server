import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';

import { CurrentUser } from '../../core/auth/current-user.decorator';
import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { RequirePermission } from '../../core/auth/permissions';
import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { AccessTokenClaims } from '../auth/token.service';
import { parseBackupFilename } from '../backups/backup-rules';
import { BackupsService } from '../backups/backups.service';
import { UpdateBackupSettingsDto } from './dto/backup-admin.dto';

/** Only an exact backup name reaches the service, so nothing else in the bucket can be addressed. */
function backupName(filename: string): string {
  if (!parseBackupFilename(filename)) {
    throw appError(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'There is no backup with that name.');
  }
  return filename;
}

/** Database backups, for the owner alone. */
@Controller('api/admin/v1/backups')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminBackupsController {
  constructor(private readonly backups: BackupsService) {}

  @Get()
  @RequirePermission('backups.manage')
  async overview() {
    return { success: true as const, data: await this.backups.overview() };
  }

  @Put('settings')
  @RequirePermission('backups.manage')
  async updateSettings(@Body() dto: UpdateBackupSettingsDto, @CurrentUser() user: AccessTokenClaims) {
    return { success: true as const, data: await this.backups.updateSettings(dto, user.sub) };
  }

  /** Queued, not awaited: a backup can take minutes. The page polls the overview until it ends. */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('backups.manage')
  async start(@CurrentUser() user: AccessTokenClaims) {
    await this.backups.requestBackup({ id: user.sub, email: user.email });
    return { success: true as const, data: { started: true } };
  }

  @Get(':filename/download')
  @RequirePermission('backups.manage')
  async download(@Param('filename') filename: string, @CurrentUser() user: AccessTokenClaims) {
    return { success: true as const, data: await this.backups.downloadLink(backupName(filename), user.sub) };
  }

  @Get(':filename/restore-command')
  @RequirePermission('backups.manage')
  async restoreCommand(@Param('filename') filename: string, @CurrentUser() user: AccessTokenClaims) {
    return { success: true as const, data: await this.backups.restoreCommand(backupName(filename), user.sub) };
  }

  @Delete(':filename')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('backups.manage')
  async remove(@Param('filename') filename: string, @CurrentUser() user: AccessTokenClaims) {
    await this.backups.deleteBackup(backupName(filename), user.sub);
  }
}
