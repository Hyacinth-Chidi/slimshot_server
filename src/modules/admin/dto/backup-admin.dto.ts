import { IsBoolean, IsIn, IsOptional } from 'class-validator';

import { BACKUP_INTERVALS, type BackupInterval } from '../../backups/backup-rules';

export class UpdateBackupSettingsDto {
  @IsOptional() @IsBoolean() autoEnabled?: boolean;
  /** Every day, every 7 days or every 30 days: the database refuses anything else too. */
  @IsOptional() @IsIn(BACKUP_INTERVALS) intervalDays?: BackupInterval;
}
