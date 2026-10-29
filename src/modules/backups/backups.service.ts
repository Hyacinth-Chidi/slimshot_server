import { chmod, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { InjectQueue } from '@nestjs/bullmq';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { backupConfig, type BackupConfig, databaseConfig, type DatabaseConfig } from '../../config';
import { AuditService } from '../../core/audit/audit.service';
import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import type { BackupSettings } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  backupFilename,
  type BackupInterval,
  type BackupItem,
  type BackupTrigger,
  isDue,
  nextAutoAt,
  parseBackupFilename,
} from './backup-rules';
import type { BackupStore } from './backup-store';
import {
  BACKUP_RUNTIME,
  BACKUP_STORE,
  type BackupActor,
  type BackupRunJob,
  type BackupRuntime,
  DOWNLOAD_LINK_SECONDS,
  JOB_RUN,
  QUEUE_BACKUPS,
  RESTORE_LINK_SECONDS,
  RUN_TIMEOUT_MS,
} from './backups.constants';
import { pgDumpInvocation } from './pg-dump';

export type BackupAvailability = 'ready' | 'no-bucket' | 'not-production';

export interface BackupsOverview {
  configured: boolean;
  notConfiguredReason: Exclude<BackupAvailability, 'ready'> | null;
  settings: { autoEnabled: boolean; intervalDays: BackupInterval };
  status: {
    running: boolean;
    lastRunAt: Date | null;
    lastRunOk: boolean | null;
    lastRunError: string | null;
    lastRunTrigger: BackupTrigger | null;
    nextAutoAt: Date | null;
  };
  backups: BackupItem[];
}

export type BackupSettingsPatch = Partial<BackupsOverview['settings']>;

const PARTIAL = '.partial';
const ERROR_KEPT = 2_000;
// Every manual run shares one id, so BullMQ drops a second request that races the first.
const MANUAL_RUN_DEDUP_ID = 'backup-manual-run';

function settingsOf(row: BackupSettings): BackupsOverview['settings'] {
  return { autoEnabled: row.autoEnabled, intervalDays: row.intervalDays as BackupInterval };
}

/** The list is newest first, so this is the newest automatic backup. Manual ones don't move the cadence. */
function newestAuto(backups: BackupItem[]): Date | null {
  return backups.find((b) => b.trigger === 'auto')?.createdAt ?? null;
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Database backups to the private R2 bucket: made on the owner's request or by the daily
 * check, listed from the bucket, downloaded through short-lived links. Only on the live
 * server with R2_BACKUP_BUCKET set; anywhere else every call that would touch the bucket
 * answers 503, and nothing touches it.
 */
@Injectable()
export class BackupsService {
  // Dumps this process is writing; removeLeftovers must not delete them from under pg_dump.
  private readonly writing = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @InjectQueue(QUEUE_BACKUPS) private readonly queue: Queue<BackupRunJob>,
    @Inject(BACKUP_STORE) private readonly store: BackupStore | null,
    @Inject(BACKUP_RUNTIME) private readonly runtime: BackupRuntime,
    @Inject(backupConfig.KEY) private readonly cfg: BackupConfig,
    @Inject(databaseConfig.KEY) private readonly db: DatabaseConfig,
  ) {}

  availability(): BackupAvailability {
    if (!this.cfg.production) return 'not-production';
    if (!this.cfg.bucket || !this.store) return 'no-bucket';
    return 'ready';
  }

  async overview(now = new Date()): Promise<BackupsOverview> {
    const row = await this.settingsRow();
    const settings = settingsOf(row);
    const lastRun = {
      lastRunAt: row.lastRunAt,
      lastRunOk: row.lastRunOk,
      lastRunError: row.lastRunError,
      lastRunTrigger: row.lastRunTrigger as BackupTrigger | null,
    };
    const availability = this.availability();
    if (availability !== 'ready') {
      return {
        configured: false,
        notConfiguredReason: availability,
        settings,
        status: { running: false, ...lastRun, nextAutoAt: null },
        backups: [],
      };
    }
    const [backups, running] = await Promise.all([this.requireStore().list(), this.isRunning()]);
    return {
      configured: true,
      notConfiguredReason: null,
      settings,
      status: { running, ...lastRun, nextAutoAt: nextAutoAt(now, settings, newestAuto(backups)) },
      backups,
    };
  }

  async updateSettings(patch: BackupSettingsPatch, adminId: string): Promise<BackupsOverview['settings']> {
    const before = settingsOf(await this.settingsRow());
    const after = settingsOf(
      await this.prisma.backupSettings.update({
        where: { id: 'default' },
        data: { ...patch, updatedById: adminId },
      }),
    );
    await this.audit.record({
      actorId: adminId,
      actorType: 'admin',
      action: 'backup.settings.updated',
      entityType: 'BackupSettings',
      entityId: 'default',
      before,
      after,
    });
    return after;
  }

  /** Queues a backup now. The worker runs one job at a time. */
  async requestBackup(admin: BackupActor): Promise<void> {
    this.requireStore();
    if (await this.isRunning()) {
      throw appError(HttpStatus.CONFLICT, ErrorCode.CONFLICT, 'A backup is already running.');
    }
    await this.queue.add(
      JOB_RUN,
      { trigger: 'manual', actor: { id: admin.id, email: admin.email } },
      { deduplication: { id: MANUAL_RUN_DEDUP_ID }, removeOnComplete: true, removeOnFail: true },
    );
  }

  /**
   * Dumps the database to a private temp file, uploads it only if pg_dump succeeded and the
   * file isn't empty, and records and audits the outcome. The temp file goes whatever happens.
   */
  async runBackup(trigger: BackupTrigger, actor: BackupActor | null): Promise<BackupItem> {
    const store = this.requireStore();
    // Whole seconds, so the time in the name and the recorded run time agree.
    const createdAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    const filename = backupFilename(createdAt, trigger);
    const partial = join(this.runtime.tmpDir, `${filename}${PARTIAL}`);
    const metadata: Record<string, string> = actor ? { trigger, 'created-by': actor.email } : { trigger };
    const by = actor ? { actorId: actor.id, actorType: 'admin' as const } : { actorType: 'system' as const };

    let sizeBytes: number;
    this.writing.add(partial);
    try {
      await this.createPrivateFile(partial);
      await this.runtime.dump(pgDumpInvocation(this.db.url, partial), { timeoutMs: RUN_TIMEOUT_MS });
      if ((await stat(partial)).size === 0) throw new Error('The database dump came out empty.');
      ({ sizeBytes } = await store.upload(partial, filename, metadata));
    } catch (err) {
      const reason = this.scrub(err instanceof Error ? err.message : String(err)).slice(0, ERROR_KEPT);
      await this.recordRun(createdAt, trigger, reason);
      await this.audit.record({
        ...by,
        action: 'backup.failed',
        entityType: 'Backup',
        entityId: filename,
        after: { trigger, error: reason },
      });
      throw new Error(reason);
    } finally {
      await rm(partial, { force: true });
      this.writing.delete(partial);
    }

    await this.recordRun(createdAt, trigger, null);
    await this.audit.record({
      ...by,
      action: 'backup.created',
      entityType: 'Backup',
      entityId: filename,
      after: { trigger, sizeBytes },
    });
    return { filename, sizeBytes, createdAt, trigger };
  }

  /** The daily job: makes an automatic backup when automatic backups are on and one is due. */
  async runScheduledCheck(now = new Date()): Promise<'ran' | 'not-due' | 'off' | 'not-configured'> {
    if (this.availability() !== 'ready') return 'not-configured';
    const settings = settingsOf(await this.settingsRow());
    if (!settings.autoEnabled) return 'off';
    if (!isDue(now, settings, newestAuto(await this.requireStore().list()))) return 'not-due';
    await this.runBackup('auto', null);
    return 'ran';
  }

  async downloadLink(filename: string, adminId: string): Promise<{ url: string; expiresAt: Date }> {
    const store = this.requireStore();
    await this.findBackup(store, filename);
    const link = await store.presignGet(filename, DOWNLOAD_LINK_SECONDS);
    // The link itself is signed for whoever holds it, so only its expiry is recorded.
    await this.audit.record({
      actorId: adminId,
      actorType: 'admin',
      action: 'backup.downloaded',
      entityType: 'Backup',
      entityId: filename,
      after: { expiresAt: link.expiresAt },
    });
    return link;
  }

  async restoreCommand(filename: string, adminId: string): Promise<{ command: string; expiresAt: Date }> {
    const store = this.requireStore();
    await this.findBackup(store, filename);
    const { url, expiresAt } = await store.presignGet(filename, RESTORE_LINK_SECONDS);
    // The owner pastes this into a root shell: a quote in the link would end the argument.
    if (url.includes("'")) throw new Error('The signed link contains a quote.');
    await this.audit.record({
      actorId: adminId,
      actorType: 'admin',
      action: 'backup.restore_command',
      entityType: 'Backup',
      entityId: filename,
      after: { expiresAt },
    });
    return { command: `./deploy/scripts/restore-db.sh '${url}'`, expiresAt };
  }

  async deleteBackup(filename: string, adminId: string): Promise<void> {
    const store = this.requireStore();
    const { backup, newest } = await this.findBackup(store, filename);
    if (newest) {
      throw appError(HttpStatus.CONFLICT, ErrorCode.CONFLICT, "The newest backup can't be deleted.");
    }
    await store.delete(filename);
    await this.audit.record({
      actorId: adminId,
      actorType: 'admin',
      action: 'backup.deleted',
      entityType: 'Backup',
      entityId: filename,
      before: backup,
    });
  }

  /** Deletes temp dumps a crash left behind. Run on boot; never touches a dump being written. */
  async removeLeftovers(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.runtime.tmpDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const name of names) {
      const path = join(this.runtime.tmpDir, name);
      if (name.endsWith(PARTIAL) && !this.writing.has(path)) await rm(path, { force: true });
    }
  }

  private requireStore(): BackupStore {
    if (this.availability() !== 'ready' || !this.store) {
      throw appError(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.BACKUPS_NOT_CONFIGURED,
        'Backups are not set up on this server.',
      );
    }
    return this.store;
  }

  private async findBackup(store: BackupStore, filename: string): Promise<{ backup: BackupItem; newest: boolean }> {
    // A name that isn't exactly a backup's is never looked up, let alone used as a key.
    const backups = parseBackupFilename(filename) ? await store.list() : [];
    const index = backups.findIndex((b) => b.filename === filename);
    if (index < 0) throw appError(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'There is no backup with that name.');
    return { backup: backups[index], newest: index === 0 };
  }

  // Only "running" and "waiting": the next daily check sits in "delayed" all day.
  private async isRunning(): Promise<boolean> {
    const counts = await this.queue.getJobCounts('active', 'waiting');
    return (counts.active ?? 0) + (counts.waiting ?? 0) > 0;
  }

  private settingsRow(): Promise<BackupSettings> {
    return this.prisma.backupSettings.findUniqueOrThrow({ where: { id: 'default' } });
  }

  private async recordRun(at: Date, trigger: BackupTrigger, error: string | null): Promise<void> {
    await this.prisma.backupSettings.update({
      where: { id: 'default' },
      data: { lastRunAt: at, lastRunOk: error === null, lastRunError: error, lastRunTrigger: trigger },
    });
  }

  /** The folder is 0700 and the file 0600: the dump holds every account. pg_dump keeps the mode of a file it truncates. */
  private async createPrivateFile(path: string): Promise<void> {
    await mkdir(this.runtime.tmpDir, { recursive: true, mode: 0o700 });
    // mkdir's mode applies only to a folder it creates.
    await chmod(this.runtime.tmpDir, 0o700);
    await rm(path, { force: true });
    await writeFile(path, '', { mode: 0o600, flag: 'wx' });
  }

  /** The database password, as written in DATABASE_URL and decoded, never leaves in an error. */
  private scrub(text: string): string {
    const raw = new URL(this.db.url).password;
    const secrets = [raw, decoded(raw)].filter(Boolean).sort((a, b) => b.length - a.length);
    return secrets.reduce((out, secret) => out.split(secret).join('[redacted]'), text);
  }
}
