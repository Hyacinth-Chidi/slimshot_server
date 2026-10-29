/** What started a backup: the daily check, or the owner from the dashboard. */
export type BackupTrigger = 'auto' | 'manual';

/** Every backup lives under this prefix in the backup bucket; anything else there is ignored. */
export const BACKUP_PREFIX = 'postgres/';

/** How often automatic backups can run, in days. The dashboard offers exactly these. */
export const BACKUP_INTERVALS = [1, 7, 30] as const;
export type BackupInterval = (typeof BACKUP_INTERVALS)[number];

/** The daily check runs at this time, UTC; automatic backups only ever start then. */
export const DAILY_CHECK_UTC = { hour: 3, minute: 15 } as const;

export interface BackupItem {
  filename: string;
  sizeBytes: number;
  createdAt: Date;
  trigger: BackupTrigger;
}

export interface BackupSchedule {
  autoEnabled: boolean;
  intervalDays: number;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// A run that ends a few seconds after 03:15 must not push the next one back a day.
const SLACK = HOUR;

const FILENAME = /^slimshot-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(auto|manual)\.dump$/;

/** `slimshot-YYYYMMDD-HHMMSS-<trigger>.dump`, in UTC: names sort by time. */
export function backupFilename(at: Date, trigger: BackupTrigger): string {
  const stamp = at.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  return `slimshot-${stamp}-${trigger}.dump`;
}

/** The time and trigger in a backup's name, or null when the name is not exactly one of ours. */
export function parseBackupFilename(name: string): { createdAt: Date; trigger: BackupTrigger } | null {
  const match = FILENAME.exec(name);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const trigger = match[7] as BackupTrigger;
  const createdAt = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  // Date.UTC rolls month 13 or hour 25 over into a later date; only a real time round-trips.
  if (backupFilename(createdAt, trigger) !== name) return null;
  return { createdAt, trigger };
}

function earliestAfter(lastAutoAt: Date, s: BackupSchedule): number {
  return lastAutoAt.getTime() + s.intervalDays * DAY - SLACK;
}

/** Whether the daily check should start an automatic backup now. Manual backups don't count. */
export function isDue(now: Date, s: BackupSchedule, lastAutoAt: Date | null): boolean {
  if (!s.autoEnabled) return false;
  return lastAutoAt === null || now.getTime() >= earliestAfter(lastAutoAt, s);
}

/** When the next automatic backup will start: the first daily check at which it is due. */
export function nextAutoAt(now: Date, s: BackupSchedule, lastAutoAt: Date | null): Date | null {
  if (!s.autoEnabled) return null;
  const earliest = lastAutoAt ? earliestAfter(lastAutoAt, s) : now.getTime();
  const todays = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    DAILY_CHECK_UTC.hour,
    DAILY_CHECK_UTC.minute,
  );
  let candidate = todays > now.getTime() ? todays : todays + DAY;
  while (candidate < earliest) candidate += DAY;
  return new Date(candidate);
}
