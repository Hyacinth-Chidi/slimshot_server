import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { configureHttp } from '../../app.setup';
import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { PERMISSION_KEY } from '../../core/auth/permissions';
import { AdminUserStatsController } from './admin-user-stats.controller';
import { AdminUsersService } from './admin-users.service';

const pass = { canActivate: () => true };

describe('GET /api/admin/v1/stats/users', () => {
  let app: INestApplication;
  let base: string;
  const users = { userStats: jest.fn(async () => ({ total: 1284, newInPeriod: 86 })) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminUserStatsController],
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
    base = `${await app.getUrl()}/api/admin/v1/stats/users`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers with the user counts for the period', async () => {
    const res = await fetch(`${base}?days=7`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { total: 1284, newInPeriod: 86 } });
    expect(users.userStats).toHaveBeenLastCalledWith(7);
  });

  it('defaults to 30 days', async () => {
    await fetch(base);
    expect(users.userStats).toHaveBeenLastCalledWith(30);
  });

  it.each(['0', '366', 'abc'])('422s days=%s', async (days) => {
    expect((await fetch(`${base}?days=${days}`)).status).toBe(422);
  });

  it('needs users.read', () => {
    const handler = AdminUserStatsController.prototype.stats;
    expect(Reflect.getMetadata(PERMISSION_KEY, handler)).toBe('users.read');
  });
});
