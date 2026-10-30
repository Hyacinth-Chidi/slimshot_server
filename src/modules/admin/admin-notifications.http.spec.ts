import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { configureHttp } from '../../app.setup';
import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { PERMISSION_KEY, roleHas } from '../../core/auth/permissions';
import { PushService } from '../push/push.service';
import { AdminNotificationsController } from './admin-notifications.controller';

const pass = {
  canActivate(ctx: { switchToHttp: () => { getRequest: () => { user?: unknown } } }) {
    ctx.switchToHttp().getRequest().user = { sub: 'admin-1', email: 'o@example.com', role: 'owner' };
    return true;
  },
};

describe('admin notifications API over HTTP', () => {
  let app: INestApplication;
  let base: string;
  const push = {
    overview: jest.fn(async () => ({ configured: true, devices: 3, messages: [] })),
    send: jest.fn(async () => ({ id: 'msg-1' })),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminNotificationsController],
      providers: [{ provide: PushService, useValue: push }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(pass)
      .overrideGuard(PermissionsGuard)
      .useValue(pass)
      .compile();
    app = moduleRef.createNestApplication();
    configureHttp(app);
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/api/admin/v1/notifications`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => jest.clearAllMocks());

  const post = (body: unknown) =>
    fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('answers the overview', async () => {
    expect(await (await fetch(base)).json()).toEqual({ success: true, data: { configured: true, devices: 3, messages: [] } });
  });

  it('queues a message with 202, from the signed-in admin', async () => {
    const res = await post({ title: 'New sounds', body: 'Ten new sounds are in.' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ success: true, data: { id: 'msg-1' } });
    expect(push.send).toHaveBeenCalledWith({ title: 'New sounds', body: 'Ten new sounds are in.' }, { id: 'admin-1' });
  });

  it('passes on one user to send to', async () => {
    await post({ title: 'Hi', body: 'Just for you', user: 'amaka@x.com' });
    expect(push.send).toHaveBeenCalledWith({ title: 'Hi', body: 'Just for you', user: 'amaka@x.com' }, { id: 'admin-1' });
  });

  it.each([
    [{ body: 'no title' }],
    [{ title: '', body: 'x' }],
    [{ title: '   ', body: 'x' }],
    [{ title: 'x'.repeat(101), body: 'x' }],
    [{ title: 'x', body: 'x'.repeat(1001) }],
    [{ title: 'x', body: 'x', audience: 'all' }],
  ])('422s %j', async (body) => {
    expect((await post(body)).status).toBe(422);
    expect(push.send).not.toHaveBeenCalled();
  });

  it('needs notifications.send, which only the owner has', () => {
    const proto = AdminNotificationsController.prototype;
    expect(Reflect.getMetadata(PERMISSION_KEY, proto.overview)).toBe('notifications.send');
    expect(Reflect.getMetadata(PERMISSION_KEY, proto.send)).toBe('notifications.send');
    expect(roleHas('owner', 'notifications.send')).toBe(true);
    for (const role of ['admin', 'editor', 'viewer'] as const) expect(roleHas(role, 'notifications.send')).toBe(false);
  });
});
