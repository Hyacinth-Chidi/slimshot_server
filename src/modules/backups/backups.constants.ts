import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DAILY_CHECK_UTC, type BackupTrigger } from './backup-rules';
import { type PgDumpInvocation, runPgDump } from './pg-dump';

export const QUEUE_BACKUPS = 'backups';

/** Makes one backup. */
export const JOB_RUN = 'run';
/** The daily check: makes an automatic backup when one is due. */
export const JOB_CHECK = 'check';

export const BACKUP_CHECK_SCHEDULER = 'backup-daily-check';
export const BACKUP_CHECK_PATTERN = `${DAILY_CHECK_UTC.minute} ${DAILY_CHECK_UTC.hour} * * *`;
export const BACKUP_CHECK_TZ = 'UTC';

/** A run past this is stopped and recorded as failed. */
export const RUN_TIMEOUT_MS = 30 * 60_000;
export const DOWNLOAD_LINK_SECONDS = 300;
export const RESTORE_LINK_SECONDS = 3_600;

export interface BackupActor {
  id: string;
  email: string;
}

export interface BackupRunJob {
  trigger: BackupTrigger;
  /** Who asked for it; null for an automatic backup. */
  actor: BackupActor | null;
}

/** `BackupStore`, or null unless this is the live server and the bucket is set. */
export const BACKUP_STORE = Symbol('BACKUP_STORE');

/** Where dumps are written before upload, and what writes them; tests stand in for both. */
export interface BackupRuntime {
  tmpDir: string;
  dump: (inv: PgDumpInvocation, opts: { timeoutMs: number }) => Promise<void>;
}
export const BACKUP_RUNTIME = Symbol('BACKUP_RUNTIME');

export const DEFAULT_BACKUP_RUNTIME: BackupRuntime = {
  tmpDir: join(tmpdir(), 'slimshot-backups'),
  dump: runPgDump,
};
