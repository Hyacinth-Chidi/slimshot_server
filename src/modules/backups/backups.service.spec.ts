import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BackupItem } from './backup-rules';
import type { BackupRuntime } from './backups.constants';
import { BackupsService } from './backups.service';
import type { PgDumpInvocation } from './pg-dump';

const DATABASE_URL = 'postgresql://slimshot:s3cr%40t@postgres:5432/slimshot?schema=public';
const PASSWORD = 's3cr@t';
const ADMIN = { id: 'admin-1', email: 'owner@example.com' };
const HOUR = 3_600_000;

const item = (filename: string, sizeBytes = 100): BackupItem => {
  const [, d, t, trigger] = /^slimshot-(\d{8})-(\d{6})-(auto|manual)\.dump$/.exec(filename)!;
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4)}Z`;
  return { filename, sizeBytes, createdAt: new Date(iso), trigger: trigger as 'auto' | 'manual' };
};
const stamp = (at: Date) => at.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
const named = (at: Date, trigger: 'auto' | 'manual') => item(`slimshot-${stamp(at)}-${trigger}.dump`);

/** Where the dump file lives in a pg_dump invocation. */
const outFile = (inv: PgDumpInvocation) => inv.args[inv.args.indexOf('--file') + 1];

function build(opts: { production?: boolean; bucket?: string | null; backups?: BackupItem[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'backups-service-'));
  const row = {
    id: 'default',
    autoEnabled: true,
    intervalDays: 1,
    lastRunAt: null as Date | null,
    lastRunOk: null as boolean | null,
    lastRunError: null as string | null,
    lastRunTrigger: null as string | null,
    updatedById: null as string | null,
    updatedAt: new Date('2026-10-01T00:00:00Z'),
  };
  const prisma = {
    backupSettings: {
      findUniqueOrThrow: jest.fn(async () => ({ ...row })),
      update: jest.fn(async ({ data }: { data: Partial<typeof row> }) => {
        Object.assign(row, data);
        return { ...row };
      }),
    },
  };
  const uploaded: { path: string; filename: string; metadata: Record<string, string>; contents: string }[] = [];
  const store = {
    list: jest.fn(async () => opts.backups ?? []),
    upload: jest.fn(async (path: string, filename: string, metadata: Record<string, string>) => {
      uploaded.push({ path, filename, metadata, contents: readFileSync(path, 'utf8') });
      return { sizeBytes: statSync(path).size };
    }),
    presignGet: jest.fn(async (filename: string, seconds: number) => ({
      url: `https://acct.r2.cloudflarestorage.com/slimshot-backups/postgres/${filename}?X-Amz-Expires=${seconds}&X-Amz-Signature=abc`,
      expiresAt: new Date(Date.now() + seconds * 1000),
    })),
    delete: jest.fn(async (_filename: string) => undefined),
  };
  const runtime = {
    tmpDir: join(root, 'slimshot-backups'),
    dump: jest.fn(async (inv: PgDumpInvocation, _opts: { timeoutMs: number }) => {
      writeFileSync(outFile(inv), 'DUMPDATA');
    }),
  } satisfies BackupRuntime;
  const queue = {
    getJobCounts: jest.fn(async (..._states: string[]) => ({ active: 0, waiting: 0 })),
    add: jest.fn(async (..._args: unknown[]) => ({})),
  };
  const audit = { record: jest.fn(async (_entry: unknown) => undefined) };
  const cfg = {
    production: opts.production ?? true,
    bucket: opts.bucket === undefined ? 'slimshot-backups' : opts.bucket,
  };
  const svc = new BackupsService(
    prisma as never,
    audit as never,
    queue as never,
    store as never,
    runtime,
    cfg,
    { url: DATABASE_URL },
  );
  return { svc, prisma, store, runtime, queue, audit, row, uploaded, root };
}

type Built = ReturnType<typeof build>;
const built: Built[] = [];
function setup(opts?: Parameters<typeof build>[0]): Built {
  const b = build(opts);
  built.push(b);
  return b;
}
afterEach(() => {
  for (const b of built.splice(0)) rmSync(b.root, { recursive: true, force: true });
});

const actions = (audit: Built['audit']) =>
  audit.record.mock.calls.map(([entry]) => (entry as { action: string }).action);

describe('BackupsService when backups are not set up', () => {
  it('is not configured outside production, and touches nothing', async () => {
    const { svc, store, queue, runtime } = setup({ production: false });
    expect(svc.availability()).toBe('not-production');

    const overview = await svc.overview();
    expect(overview).toMatchObject({
      configured: false,
      notConfiguredReason: 'not-production',
      settings: { autoEnabled: true, intervalDays: 1 },
      status: { running: false, nextAutoAt: null },
      backups: [],
    });

    const notSetUp = { status: 503, response: { code: 'BACKUPS_NOT_CONFIGURED', message: 'Backups are not set up on this server.' } };
    await expect(svc.requestBackup(ADMIN)).rejects.toMatchObject(notSetUp);
    await expect(svc.runBackup('manual', ADMIN)).rejects.toMatchObject(notSetUp);
    await expect(svc.downloadLink('slimshot-20261029-031507-auto.dump', ADMIN.id)).rejects.toMatchObject(notSetUp);
    await expect(svc.restoreCommand('slimshot-20261029-031507-auto.dump', ADMIN.id)).rejects.toMatchObject(notSetUp);
    await expect(svc.deleteBackup('slimshot-20261029-031507-auto.dump', ADMIN.id)).rejects.toMatchObject(notSetUp);
    expect(await svc.runScheduledCheck()).toBe('not-configured');

    for (const fn of [store.list, store.upload, store.presignGet, store.delete, queue.getJobCounts, queue.add, runtime.dump]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('is not configured without a bucket', async () => {
    const { svc } = setup({ bucket: null });
    expect(svc.availability()).toBe('no-bucket');
    expect(await svc.overview()).toMatchObject({ configured: false, notConfiguredReason: 'no-bucket', backups: [] });
  });
});

describe('BackupsService.runBackup', () => {
  it('backs up: dumps, checks, uploads, records, audits, cleans up', async () => {
    const { svc, runtime, uploaded, row, audit } = setup();

    const result = await svc.runBackup('manual', ADMIN);

    const [inv] = runtime.dump.mock.calls[0];
    expect(outFile(inv)).toBe(join(runtime.tmpDir, `${result.filename}.partial`));
    expect(inv.env.PGPASSWORD).toBe(PASSWORD);
    expect(runtime.dump.mock.calls[0][1]).toEqual({ timeoutMs: 30 * 60_000 });

    expect(result.filename).toMatch(/^slimshot-\d{8}-\d{6}-manual\.dump$/);
    expect(result).toMatchObject({ sizeBytes: 8, trigger: 'manual' });
    expect(uploaded).toEqual([
      {
        path: outFile(inv),
        filename: result.filename,
        metadata: { trigger: 'manual', 'created-by': ADMIN.email },
        contents: 'DUMPDATA',
      },
    ]);

    expect(row).toMatchObject({ lastRunOk: true, lastRunError: null, lastRunTrigger: 'manual' });
    expect(row.lastRunAt?.getTime()).toBe(result.createdAt.getTime());
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'backup.created',
        actorId: ADMIN.id,
        actorType: 'admin',
        entityType: 'Backup',
        entityId: result.filename,
      }),
    );
    expect(readdirSync(runtime.tmpDir)).toEqual([]);
  });

  it('keeps the dump private while it is on disk, even in a folder left open', async () => {
    if (process.platform === 'win32') return; // no POSIX modes
    const { svc, store, runtime } = setup();
    mkdirSync(runtime.tmpDir, { mode: 0o755 });
    const modes: number[] = [];
    store.upload.mockImplementationOnce(async (path: string) => {
      modes.push(statSync(runtime.tmpDir).mode & 0o777, statSync(path).mode & 0o777);
      return { sizeBytes: 8 };
    });
    await svc.runBackup('auto', null);
    expect(modes).toEqual([0o700, 0o600]);
  });

  it('never uploads a failed dump, records why, and cleans up', async () => {
    const { svc, runtime, store, row, audit } = setup();
    runtime.dump.mockImplementationOnce(async (inv: PgDumpInvocation) => {
      writeFileSync(outFile(inv), 'half a dump');
      throw new Error('pg_dump: error: connection to server failed');
    });

    await expect(svc.runBackup('auto', null)).rejects.toThrow('pg_dump: error: connection to server failed');

    expect(store.upload).not.toHaveBeenCalled();
    expect(row).toMatchObject({
      lastRunOk: false,
      lastRunError: 'pg_dump: error: connection to server failed',
      lastRunTrigger: 'auto',
    });
    const failed = audit.record.mock.calls.map(([e]) => e as Record<string, unknown>).find((e) => e.action === 'backup.failed');
    expect(failed).toMatchObject({ actorType: 'system', entityType: 'Backup' });
    expect(failed?.actorId).toBeUndefined();
    expect(actions(audit)).not.toContain('backup.created');
    expect(readdirSync(runtime.tmpDir)).toEqual([]);
  });

  it('never uploads an empty dump', async () => {
    const { svc, runtime, store, row } = setup();
    runtime.dump.mockImplementationOnce(async () => undefined);

    await expect(svc.runBackup('auto', null)).rejects.toThrow('The database dump came out empty.');

    expect(store.upload).not.toHaveBeenCalled();
    expect(row).toMatchObject({ lastRunOk: false, lastRunError: 'The database dump came out empty.' });
  });

  it('never stores the password in a failure', async () => {
    const { svc, runtime, row, audit } = setup();
    runtime.dump.mockImplementationOnce(async () => {
      throw new Error(`could not connect with ${PASSWORD} (${DATABASE_URL})`);
    });

    const err = (await svc.runBackup('manual', ADMIN).catch((e: unknown) => e)) as Error;

    for (const text of [err.message, row.lastRunError ?? '', JSON.stringify(audit.record.mock.calls)]) {
      expect(text).toContain('[redacted]');
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain('s3cr%40t');
    }
  });

  it('records a failed upload as a failed run', async () => {
    const { svc, store, row, runtime } = setup();
    store.upload.mockRejectedValueOnce(new Error('R2 is unreachable'));

    await expect(svc.runBackup('auto', null)).rejects.toThrow('R2 is unreachable');

    expect(row).toMatchObject({ lastRunOk: false, lastRunError: 'R2 is unreachable' });
    expect(readdirSync(runtime.tmpDir)).toEqual([]);
  });
});

describe('BackupsService.requestBackup', () => {
  it('refuses a second backup while one is queued or running', async () => {
    const { svc, queue } = setup();
    const busy = { status: 409, response: { code: 'CONFLICT', message: 'A backup is already running.' } };

    queue.getJobCounts.mockResolvedValueOnce({ active: 1, waiting: 0 });
    await expect(svc.requestBackup(ADMIN)).rejects.toMatchObject(busy);
    queue.getJobCounts.mockResolvedValueOnce({ active: 0, waiting: 1 });
    await expect(svc.requestBackup(ADMIN)).rejects.toMatchObject(busy);

    expect(queue.getJobCounts).toHaveBeenCalledWith('active', 'waiting');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('queues a manual backup with the admin, once even if asked twice at once', async () => {
    const { svc, queue } = setup();

    await svc.requestBackup(ADMIN);

    expect(queue.add).toHaveBeenCalledWith(
      'run',
      { trigger: 'manual', actor: ADMIN },
      expect.objectContaining({ deduplication: { id: expect.any(String) } }),
    );
  });
});

describe('BackupsService.runScheduledCheck', () => {
  const now = new Date('2026-10-29T03:15:00Z');

  it('runs the daily check only when due', async () => {
    const off = setup({ backups: [] });
    off.row.autoEnabled = false;
    expect(await off.svc.runScheduledCheck(now)).toBe('off');

    const recent = setup({ backups: [named(new Date(now.getTime() - 2 * HOUR), 'auto')] });
    expect(await recent.svc.runScheduledCheck(now)).toBe('not-due');
    expect(recent.runtime.dump).not.toHaveBeenCalled();

    const old = setup({ backups: [named(new Date(now.getTime() - 25 * HOUR), 'auto')] });
    expect(await old.svc.runScheduledCheck(now)).toBe('ran');
    expect(old.uploaded[0].metadata).toEqual({ trigger: 'auto' });
    expect(old.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'backup.created', actorType: 'system' }));

    // A manual backup an hour ago doesn't reset the automatic cadence.
    const manualSince = setup({
      backups: [named(new Date(now.getTime() - HOUR), 'manual'), named(new Date(now.getTime() - 25 * HOUR), 'auto')],
    });
    expect(await manualSince.svc.runScheduledCheck(now)).toBe('ran');

    const none = setup({ backups: [] });
    expect(await none.svc.runScheduledCheck(now)).toBe('ran');
  });
});

describe('BackupsService.overview', () => {
  it('reports the next automatic backup from the newest automatic one', async () => {
    const backups = [item('slimshot-20261029-090000-manual.dump'), item('slimshot-20261028-031504-auto.dump')];
    const { svc, row, queue } = setup({ backups });
    row.intervalDays = 7;
    Object.assign(row, {
      lastRunAt: new Date('2026-10-29T09:00:00Z'),
      lastRunOk: true,
      lastRunError: null,
      lastRunTrigger: 'manual',
    });
    queue.getJobCounts.mockResolvedValueOnce({ active: 1, waiting: 0 });

    expect(await svc.overview(new Date('2026-10-29T10:00:00Z'))).toEqual({
      configured: true,
      notConfiguredReason: null,
      settings: { autoEnabled: true, intervalDays: 7 },
      status: {
        running: true,
        lastRunAt: new Date('2026-10-29T09:00:00Z'),
        lastRunOk: true,
        lastRunError: null,
        lastRunTrigger: 'manual',
        nextAutoAt: new Date('2026-11-04T03:15:00Z'),
      },
      backups,
    });
  });
});

describe('BackupsService links and delete', () => {
  const newest = 'slimshot-20261029-031507-auto.dump';
  const older = 'slimshot-20261028-031502-auto.dump';
  const backups = [item(newest), item(older, 250)];

  it('refuses to delete the newest backup, deletes others, 404s strangers and audits', async () => {
    const { svc, store, audit } = setup({ backups });

    await expect(svc.deleteBackup(newest, ADMIN.id)).rejects.toMatchObject({
      status: 409,
      response: { code: 'CONFLICT', message: "The newest backup can't be deleted." },
    });
    await expect(svc.deleteBackup('slimshot-20200101-000000-auto.dump', ADMIN.id)).rejects.toMatchObject({
      status: 404,
      response: { code: 'NOT_FOUND' },
    });
    await expect(svc.deleteBackup('../notes.txt', ADMIN.id)).rejects.toMatchObject({ status: 404 });
    expect(store.delete).not.toHaveBeenCalled();

    await svc.deleteBackup(older, ADMIN.id);
    expect(store.delete).toHaveBeenCalledWith(older);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'backup.deleted', actorId: ADMIN.id, actorType: 'admin', entityType: 'Backup', entityId: older }),
    );
  });

  it('hands out 5-minute download links and 1-hour restore commands, audited', async () => {
    const { svc, store, audit } = setup({ backups });

    const download = await svc.downloadLink(older, ADMIN.id);
    expect(store.presignGet).toHaveBeenLastCalledWith(older, 300);
    expect(download.url).toContain(older);

    const restore = await svc.restoreCommand(older, ADMIN.id);
    expect(store.presignGet).toHaveBeenLastCalledWith(older, 3600);
    const url = (await store.presignGet.mock.results[1].value) as { url: string };
    expect(restore.command).toBe(`./deploy/scripts/restore-db.sh '${url.url}'`);

    expect(actions(audit)).toEqual(['backup.downloaded', 'backup.restore_command']);
    // A signed link works for whoever holds it: it never goes in the audit log.
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('X-Amz-Signature');

    await expect(svc.downloadLink('slimshot-20200101-000000-auto.dump', ADMIN.id)).rejects.toMatchObject({ status: 404 });
    await expect(svc.restoreCommand('notes.txt', ADMIN.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe('BackupsService.updateSettings', () => {
  it('saves settings and audits them', async () => {
    const { svc, prisma, audit } = setup();

    expect(await svc.updateSettings({ intervalDays: 7 }, ADMIN.id)).toEqual({ autoEnabled: true, intervalDays: 7 });

    expect(prisma.backupSettings.update).toHaveBeenCalledWith({
      where: { id: 'default' },
      data: { intervalDays: 7, updatedById: ADMIN.id },
    });
    expect(audit.record).toHaveBeenCalledWith({
      actorId: ADMIN.id,
      actorType: 'admin',
      action: 'backup.settings.updated',
      entityType: 'BackupSettings',
      entityId: 'default',
      before: { autoEnabled: true, intervalDays: 1 },
      after: { autoEnabled: true, intervalDays: 7 },
    });
  });
});

describe('BackupsService.removeLeftovers', () => {
  it('deletes dumps a crash left behind, but not one being written, nor anything else', async () => {
    const { svc, runtime } = setup();
    mkdirSync(runtime.tmpDir, { recursive: true });
    writeFileSync(join(runtime.tmpDir, 'slimshot-20261028-031500-auto.dump.partial'), 'old');
    writeFileSync(join(runtime.tmpDir, 'notes.txt'), 'not ours');

    let release!: () => void;
    let started!: () => void;
    const dumping = new Promise<void>((resolve) => (started = resolve));
    runtime.dump.mockImplementationOnce(async (inv: PgDumpInvocation) => {
      writeFileSync(outFile(inv), 'DUMPDATA');
      started();
      await new Promise<void>((resolve) => (release = resolve));
    });
    const run = svc.runBackup('manual', ADMIN);
    await dumping;

    await svc.removeLeftovers();

    const left = readdirSync(runtime.tmpDir).sort();
    expect(left).toHaveLength(2);
    expect(left).toContain('notes.txt');
    expect(left.find((n) => n.endsWith('-manual.dump.partial'))).toBeDefined();
    release();
    await run;
    expect(readdirSync(runtime.tmpDir)).toEqual(['notes.txt']);
  });

  it('does nothing when there is no temp folder yet', async () => {
    const { svc } = setup();
    await expect(svc.removeLeftovers()).resolves.toBeUndefined();
  });
});
