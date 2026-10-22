import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { configureHttp } from '../../app.setup';
import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { AssetService } from '../assets/asset.service';
import { FontsService } from '../fonts/fonts.service';
import { IngestService } from '../ingest/ingest.service';
import { AdminAssetsController } from './admin-assets.controller';

const pass = {
  canActivate(ctx: { switchToHttp: () => { getRequest: () => { user?: unknown } } }) {
    ctx.switchToHttp().getRequest().user = { sub: 'admin-1', email: 'o@example.com', role: 'owner' };
    return true;
  },
};

describe('admin assets API over HTTP: covers and categories', () => {
  let app: INestApplication;
  let base: string;
  const assets = {
    update: jest.fn(async () => ({ id: 'a1' })),
    softDelete: jest.fn(async () => undefined),
    list: jest.fn(async () => ({ data: [], meta: { nextCursor: null } })),
  };
  const ingest = {
    createTicket: jest.fn(async () => ({ assetId: 'a1', sessionId: 's1' })),
    removeCover: jest.fn(async () => undefined),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminAssetsController],
      providers: [
        { provide: AssetService, useValue: assets },
        { provide: IngestService, useValue: ingest },
        { provide: FontsService, useValue: { refreshPreview: jest.fn() } },
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
    base = `${await app.getUrl()}/api/admin/v1/assets`;
  });

  afterAll(async () => {
    await app.close();
  });

  const json = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it('removes a cover with 204 and no body', async () => {
    const res = await json('DELETE', '/a1/cover');
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(ingest.removeCover).toHaveBeenCalledWith('a1', 'admin-1');
    expect(assets.softDelete).not.toHaveBeenCalled();
  });

  it('accepts a cover ticket for an existing sound', async () => {
    const res = await json('POST', '/upload-ticket', {
      role: 'thumbnail',
      assetId: 'a1',
      filename: 'c.png',
      mimeType: 'image/png',
      byteSize: 10,
    });
    expect(res.status).toBe(201);
  });

  it.each([
    ['a role uploads cannot use', { role: 'preview', assetId: 'a1', filename: 'c.png', mimeType: 'image/png', byteSize: 10 }],
    ['a cover ticket without the sound', { role: 'thumbnail', filename: 'c.png', mimeType: 'image/png', byteSize: 10 }],
    ['an audio ticket without its kind', { filename: 'a.mp3', mimeType: 'audio/mpeg', byteSize: 10 }],
  ])('422s %s', async (_name, body) => {
    expect((await json('POST', '/upload-ticket', body)).status).toBe(422);
  });

  it('accepts a category (or null) on update and a category filter on the list', async () => {
    expect((await json('PATCH', '/a1', { categoryId: 'c1' })).status).toBe(200);
    expect((await json('PATCH', '/a1', { categoryId: null })).status).toBe(200);
    expect((await json('GET', '/?categoryId=c1')).status).toBe(200);
    expect(assets.list).toHaveBeenCalledWith(expect.objectContaining({ categoryId: 'c1' }));
  });
});
