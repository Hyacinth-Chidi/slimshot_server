import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { configureHttp } from '../../app.setup';
import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { PERMISSION_KEY } from '../../core/auth/permissions';
import { VoicesService } from '../voices/voices.service';
import { AdminVoicesController } from './admin-voices.controller';

const pass = {
  canActivate(ctx: { switchToHttp: () => { getRequest: () => { user?: unknown } } }) {
    ctx.switchToHttp().getRequest().user = { sub: 'admin-1', email: 'o@example.com', role: 'owner' };
    return true;
  },
};

const ROW = { id: 'v1', provider: 'xai', providerVoiceId: 'eve', label: 'Eve', sortOrder: 0, enabled: false, sampleUrl: null };

describe('admin voices API over HTTP', () => {
  let app: INestApplication;
  let base: string;
  const voices = {
    listForAdmin: jest.fn(async () => [ROW]),
    sync: jest.fn(async () => [ROW]),
    update: jest.fn(async () => ROW),
    reorder: jest.fn(async () => [ROW]),
    makeSample: jest.fn(async () => ({ ...ROW, sampleUrl: 'https://cdn.example/s.mp3' })),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminVoicesController],
      providers: [{ provide: VoicesService, useValue: voices }],
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
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it('lists the voices', async () => {
    const res = await send('GET', '/voices');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: [ROW] });
  });

  it('syncs from the provider', async () => {
    const res = await send('POST', '/voices/sync');
    expect(res.status).toBe(200);
    expect(voices.sync).toHaveBeenCalledWith('admin-1');
  });

  it('renames and switches a voice', async () => {
    const res = await send('PATCH', '/voices/v1', { label: 'Narrator', enabled: true });
    expect(res.status).toBe(200);
    expect(voices.update).toHaveBeenCalledWith('v1', { label: 'Narrator', enabled: true }, 'admin-1');
  });

  it('refuses an empty or overlong label', async () => {
    expect((await send('PATCH', '/voices/v1', { label: '   ' })).status).toBe(422);
    expect((await send('PATCH', '/voices/v1', { label: 'x'.repeat(41) })).status).toBe(422);
  });

  it('saves an order', async () => {
    const res = await send('PUT', '/voices/order', { ids: ['v2', 'v1'] });
    expect(res.status).toBe(200);
    expect(voices.reorder).toHaveBeenCalledWith(['v2', 'v1'], 'admin-1');
  });

  it('makes a sample', async () => {
    const res = await send('POST', '/voices/v1/sample');
    expect(res.status).toBe(200);
    expect(voices.makeSample).toHaveBeenCalledWith('v1', 'admin-1');
  });

  it('every route needs providers.manage', () => {
    for (const name of ['list', 'sync', 'update', 'reorder', 'makeSample'] as const) {
      const handler = AdminVoicesController.prototype[name] as unknown as object;
      expect(Reflect.getMetadata(PERMISSION_KEY, handler)).toBe('providers.manage');
    }
  });
});
