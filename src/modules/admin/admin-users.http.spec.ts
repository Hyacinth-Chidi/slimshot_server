import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { configureHttp } from '../../app.setup';
import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { AdminCreditStatsController } from './admin-credit-stats.controller';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';

const pass = {
  canActivate(ctx: { switchToHttp: () => { getRequest: () => { user?: unknown } } }) {
    ctx.switchToHttp().getRequest().user = { sub: 'admin-1', email: 'o@example.com', role: 'owner' };
    return true;
  },
};

describe('admin users API over HTTP', () => {
  let app: INestApplication;
  let base: string;
  const users = {
    search: jest.fn(async () => ({ items: [], nextCursor: null })),
    adjust: jest.fn(async () => ({ balance: 5 })),
    remove: jest.fn(async () => undefined),
    creditStats: jest.fn(async () => []),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminUsersController, AdminCreditStatsController],
      providers: [{ provide: AdminUsersService, useValue: users }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(pass)
      .overrideGuard(PermissionsGuard)
      .useValue(pass)
      .compile();
    app = moduleRef.createNestApplication();
    configureHttp(app);
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/api/admin/v1`;
  });

  afterAll(async () => {
    await app.close();
  });

  const send = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('passes the search term, cursor and a numeric limit', async () => {
    expect((await send('GET', '/users?q=ada&cursor=c1&limit=5')).status).toBe(200);
    expect(users.search).toHaveBeenCalledWith('ada', 'c1', 5);
  });

  it('adjusts with 200 and the admin id', async () => {
    expect((await send('POST', '/users/u1/adjustments', { amount: -3, reason: 'Refund dispute' })).status).toBe(200);
    expect(users.adjust).toHaveBeenCalledWith('u1', -3, 'Refund dispute', 'admin-1');
  });

  it.each([
    [{ amount: 0, reason: 'Nothing' }],
    [{ amount: 1.5, reason: 'Half' }],
    [{ amount: 2_000_000, reason: 'Too much' }],
    [{ amount: 5, reason: 'no' }],
    [{ amount: 5 }],
  ])('422s an invalid adjustment %j', async (body) => {
    expect((await send('POST', '/users/u1/adjustments', body)).status).toBe(422);
  });

  it('needs a reason to delete', async () => {
    expect((await send('DELETE', '/users/u1', {})).status).toBe(422);
    expect((await send('DELETE', '/users/u1', { reason: 'Asked by email' })).status).toBe(200);
    expect(users.remove).toHaveBeenCalledWith('u1', 'Asked by email', 'admin-1');
  });

  it('reports credit stats for 30 days by default and refuses 0 or more than 365', async () => {
    expect((await send('GET', '/stats/credits')).status).toBe(200);
    expect(users.creditStats).toHaveBeenCalledWith(30);
    expect((await send('GET', '/stats/credits?days=0')).status).toBe(422);
    expect((await send('GET', '/stats/credits?days=366')).status).toBe(422);
  });
});
