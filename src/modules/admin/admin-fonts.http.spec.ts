import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { configureHttp } from '../../app.setup';
import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { AssetService } from '../assets/asset.service';
import { FontsService } from '../fonts/fonts.service';
import { IngestService } from '../ingest/ingest.service';
import { AdminAssetsController } from './admin-assets.controller';
import { AdminFontsController } from './admin-fonts.controller';

const pass = {
  canActivate(ctx: { switchToHttp: () => { getRequest: () => { user?: unknown } } }) {
    ctx.switchToHttp().getRequest().user = { sub: 'admin-1', email: 'o@example.com', role: 'owner' };
    return true;
  },
};

describe('admin fonts API over HTTP', () => {
  let app: INestApplication;
  let base: string;
  const fonts = {
    order: jest.fn(async () => [{ id: 'f-a', title: 'Lato Regular', styleName: 'Regular', previewUrl: null, status: 'ready' }]),
    reorder: jest.fn(async () => undefined),
    updateLicense: jest.fn(async () => undefined),
    legacyFamilies: jest.fn(async () => [{ familyName: 'Lato', fontId: null, published: false }]),
    refreshPreview: jest.fn(async () => true),
  };
  const assets = {
    getById: jest.fn(async (id: string) => ({ id, kind: 'font', title: 'Lato', font: { license: 'OFL' } })),
    update: jest.fn(async (id: string) => ({ id, kind: 'font', title: 'New name' })),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminFontsController, AdminAssetsController],
      providers: [
        { provide: FontsService, useValue: fonts },
        { provide: AssetService, useValue: assets },
        { provide: IngestService, useValue: {} },
      ],
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

  it('lists every published font in the app order', async () => {
    const res = await send('GET', '/fonts/order');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, data: [{ id: 'f-a' }] });
    expect(fonts.order).toHaveBeenCalledWith();
  });

  it('saves a new order', async () => {
    const res = await send('POST', '/fonts/reorder', { ids: ['f-b', 'f-a'] });
    expect(res.status).toBe(204);
    expect(fonts.reorder).toHaveBeenCalledWith(['f-b', 'f-a'], 'admin-1');
  });

  it.each([
    ['no ids', {}],
    ['ids that are not strings', { ids: [1, 2] }],
  ])('422s a reorder with %s', async (_name, body) => {
    expect((await send('POST', '/fonts/reorder', body)).status).toBe(422);
  });

  it('sets or clears the licence note, and returns the font', async () => {
    const res = await send('PATCH', '/fonts/f-a', { license: 'OFL 1.1' });
    expect(res.status).toBe(200);
    expect(fonts.updateLicense).toHaveBeenCalledWith('f-a', 'OFL 1.1', 'admin-1');
    expect(await res.json()).toMatchObject({ success: true, data: { id: 'f-a' } });
    await send('PATCH', '/fonts/f-a', { license: null });
    expect(fonts.updateLicense).toHaveBeenLastCalledWith('f-a', null, 'admin-1');
  });

  it('422s a licence note over 500 characters', async () => {
    expect((await send('PATCH', '/fonts/f-a', { license: 'x'.repeat(501) })).status).toBe(422);
  });

  it('lists the 19 legacy families', async () => {
    const res = await send('GET', '/fonts/legacy-families');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, data: [{ familyName: 'Lato' }] });
  });

  it("redraws a font's preview when its display name changes", async () => {
    const res = await send('PATCH', '/assets/f-a', { title: 'New name' });
    expect(res.status).toBe(200);
    expect(fonts.refreshPreview).toHaveBeenCalledWith('f-a');
    expect(assets.getById).toHaveBeenCalledWith('f-a');
  });

  it('does not redraw when only the category changes', async () => {
    fonts.refreshPreview.mockClear();
    await send('PATCH', '/assets/f-a', { categoryId: 'trending' });
    expect(fonts.refreshPreview).not.toHaveBeenCalled();
  });
});
