import { HttpStatus, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { configureHttp } from '../../app.setup';
import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { PERMISSION_KEY, roleHas } from '../../core/auth/permissions';
import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { BackupsService } from '../backups/backups.service';
import { AdminBackupsController } from './admin-backups.controller';

const pass = {
  canActivate(ctx: { switchToHttp: () => { getRequest: () => { user?: unknown } } }) {
    ctx.switchToHttp().getRequest().user = { sub: 'admin-1', email: 'o@example.com', role: 'owner' };
    return true;
  },
};

const NAME = 'slimshot-20261029-031507-auto.dump';
const OVERVIEW = {
  configured: true,
  notConfiguredReason: null,
  settings: { autoEnabled: true, intervalDays: 1 },
  status: {
    running: false,
    lastRunAt: '2026-10-29T03:15:07.000Z',
    lastRunOk: true,
    lastRunError: null,
    lastRunTrigger: 'auto',
    nextAutoAt: '2026-10-30T03:15:00.000Z',
  },
  backups: [{ filename: NAME, sizeBytes: 2048, createdAt: '2026-10-29T03:15:07.000Z', trigger: 'auto' }],
};
const SIGNED = 'https://acct.r2.cloudflarestorage.com/slimshot-backups/postgres/x?X-Amz-Signature=abc';

describe('admin backups API over HTTP', () => {
  let app: INestApplication;
  let base: string;
  const backups = {
    overview: jest.fn(async () => OVERVIEW),
    updateSettings: jest.fn(async (patch: object) => ({ autoEnabled: true, intervalDays: 1, ...patch })),
    requestBackup: jest.fn(async (_admin: unknown) => undefined),
    downloadLink: jest.fn(async () => ({ url: SIGNED, expiresAt: new Date('2026-10-29T10:05:00Z') })),
    restoreCommand: jest.fn(async () => ({
      command: `./deploy/scripts/restore-db.sh '${SIGNED}'`,
      expiresAt: new Date('2026-10-29T11:00:00Z'),
    })),
    deleteBackup: jest.fn(async () => undefined),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminBackupsController],
      providers: [{ provide: BackupsService, useValue: backups }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(pass)
      .overrideGuard(PermissionsGuard)
      .useValue(pass)
      .compile();
    app = moduleRef.createNestApplication();
    configureHttp(app);
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/api/admin/v1/backups`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => jest.clearAllMocks());

  const send = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it('lists the overview', async () => {
    const res = await send('GET', '');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: OVERVIEW });
  });

  it('saves settings and refuses other intervals', async () => {
    const res = await send('PUT', '/settings', { intervalDays: 7 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { autoEnabled: true, intervalDays: 7 } });
    expect(backups.updateSettings).toHaveBeenCalledWith({ intervalDays: 7 }, 'admin-1');

    for (const body of [{ intervalDays: 14 }, { intervalDays: '7' }, { autoEnabled: 'yes' }, { lastRunOk: true }]) {
      expect((await send('PUT', '/settings', body)).status).toBe(422);
    }
    expect(backups.updateSettings).toHaveBeenCalledTimes(1);
  });

  it('starts a backup with 202', async () => {
    const res = await send('POST', '');
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ success: true, data: { started: true } });
    expect(backups.requestBackup).toHaveBeenCalledWith({ id: 'admin-1', email: 'o@example.com' });
  });

  it('passes on why a backup could not start', async () => {
    backups.requestBackup.mockRejectedValueOnce(
      appError(HttpStatus.CONFLICT, ErrorCode.CONFLICT, 'A backup is already running.'),
    );
    const res = await send('POST', '');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      success: false,
      error: { code: 'CONFLICT', message: 'A backup is already running.' },
    });
  });

  it('404s a name outside the backup pattern without calling the service', async () => {
    for (const [method, path] of [
      ['GET', '/notes.txt/download'],
      ['GET', '/notes.txt/restore-command'],
      ['DELETE', '/slimshot-20261029.dump'],
      ['GET', `/..%2F${NAME}/download`],
      ['DELETE', '/settings'],
    ]) {
      const res = await send(method, path);
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe('NOT_FOUND');
    }
    expect(backups.downloadLink).not.toHaveBeenCalled();
    expect(backups.restoreCommand).not.toHaveBeenCalled();
    expect(backups.deleteBackup).not.toHaveBeenCalled();
  });

  it('answers download and restore-command links', async () => {
    expect(await (await send('GET', `/${NAME}/download`)).json()).toEqual({
      success: true,
      data: { url: SIGNED, expiresAt: '2026-10-29T10:05:00.000Z' },
    });
    expect(backups.downloadLink).toHaveBeenCalledWith(NAME, 'admin-1');

    expect(await (await send('GET', `/${NAME}/restore-command`)).json()).toEqual({
      success: true,
      data: { command: `./deploy/scripts/restore-db.sh '${SIGNED}'`, expiresAt: '2026-10-29T11:00:00.000Z' },
    });
    expect(backups.restoreCommand).toHaveBeenCalledWith(NAME, 'admin-1');
  });

  it('deletes with 204', async () => {
    const res = await send('DELETE', `/${NAME}`);
    expect(res.status).toBe(204);
    expect(backups.deleteBackup).toHaveBeenCalledWith(NAME, 'admin-1');
  });

  it('needs backups.manage, which only the owner has', () => {
    const proto = AdminBackupsController.prototype;
    for (const handler of [
      proto.overview,
      proto.updateSettings,
      proto.start,
      proto.download,
      proto.restoreCommand,
      proto.remove,
    ]) {
      expect(Reflect.getMetadata(PERMISSION_KEY, handler)).toBe('backups.manage');
    }
    expect(roleHas('owner', 'backups.manage')).toBe(true);
    for (const role of ['admin', 'editor', 'viewer'] as const) {
      expect(roleHas(role, 'backups.manage')).toBe(false);
    }
  });
});
