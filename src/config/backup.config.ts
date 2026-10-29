import { ConfigType, registerAs } from '@nestjs/config';

import { parseEnv } from './env.validation';

/**
 * Database backups. They run only on the live server: a developer's server
 * shares the R2 account, and must never add to, list or delete production's
 * backups.
 */
export const backupConfig = registerAs('backup', () => {
  const env = parseEnv(process.env);
  return {
    bucket: env.R2_BACKUP_BUCKET ?? null,
    production: env.NODE_ENV === 'production',
  };
});

export type BackupConfig = ConfigType<typeof backupConfig>;
