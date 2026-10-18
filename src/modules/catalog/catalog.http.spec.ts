import { HttpStatus, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { FakeRedis } from '../../../test/fakes/fake-redis';
import { configureHttp } from '../../app.setup';
import { REDIS } from '../../core/cache/cache.service';
import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { IdentityHashService } from '../../core/identity/identity-hash.service';
import { RateLimiter } from '../../core/rate-limit/rate-limiter';
import { CATALOG_LIMITS } from './catalog-limits';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';

const ITEM = {
  id: 'a1',
  slug: 'ui-button-3f9a2c1d',
  title: 'UI Button',
  author: 'SlimShot',
  durationMs: 412,
  category: { slug: 'ui', name: 'UI' },
  cover: null,
};
const TICKET = {
  url: 'https://cdn.test/slimshot/audio/a1.mp3',
  expiresAt: '2026-10-18T12:10:00.000Z',
  filename: 'ui-button-3f9a2c1d.mp3',
  format: 'mp3',
  byteSize: 1000,
  durationMs: 412,
};

async function start(redis: unknown) {
  const catalog = {
    categories: jest.fn(async () => [{ id: 'ui', slug: 'ui', name: 'UI', children: [] }]),
    assets: jest.fn(async () => ({ items: [ITEM], nextCursor: 'a1' })),
    download: jest.fn(async () => TICKET),
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [CatalogController],
    providers: [
      RateLimiter,
      { provide: REDIS, useValue: redis },
      { provide: CatalogService, useValue: catalog },
      { provide: IdentityHashService, useValue: { hash: (_kind: string, value: string) => value } },
      { provide: CATALOG_LIMITS, useValue: { readPerMinute: 3, downloadPerMinute: 2 } },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  configureHttp(app);
  await app.listen(0, '127.0.0.1');
  return { app, catalog, base: `${await app.getUrl()}/api/app/v1/catalog` };
}

describe('public catalogue API over HTTP', () => {
  let app: INestApplication;
  let base: string;
  let catalog: Awaited<ReturnType<typeof start>>['catalog'];

  beforeEach(async () => {
    ({ app, base, catalog } = await start(new FakeRedis()));
  });

  afterEach(async () => {
    await app.close();
  });

  it('lists the categories under a root in the envelope', async () => {
    const res = await fetch(`${base}/categories?kind=audio&root=sound-effects`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: [{ id: 'ui', slug: 'ui', name: 'UI', children: [] }],
    });
    expect(catalog.categories).toHaveBeenCalledWith('audio', 'sound-effects');
  });

  it.each([
    ['no root', '/categories?kind=audio'],
    ['an unknown kind', '/categories?kind=video&root=sound-effects'],
    ['a limit over 50', '/assets?kind=audio&limit=51'],
    ['a zero limit', '/assets?kind=audio&limit=0'],
    ['no kind', '/assets'],
  ])('422s %s', async (_name, path) => {
    const res = await fetch(`${base}${path}`);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ success: false, error: { code: 'VALIDATION_FAILED' } });
  });

  it('passes a 404 from the catalogue through in the error envelope', async () => {
    catalog.categories.mockRejectedValueOnce(appError(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'No category "x" for audio.'));
    const res = await fetch(`${base}/categories?kind=audio&root=x`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
  });

  it('lists sounds with the next cursor in meta, 30 per page by default', async () => {
    const res = await fetch(`${base}/assets?kind=audio&category=ui`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: [ITEM], meta: { nextCursor: 'a1' } });
    expect(catalog.assets).toHaveBeenCalledWith(expect.objectContaining({ kind: 'audio', category: 'ui', limit: 30 }));
  });

  it('answers a download with 200 and the ticket', async () => {
    const res = await fetch(`${base}/assets/a1/download`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: TICKET });
    expect(catalog.download).toHaveBeenCalledWith('a1');
  });

  it('429s reads over the limit, saying when to retry', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await fetch(`${base}/assets?kind=audio`)).status).toBe(200);
    }
    const res = await fetch(`${base}/categories?kind=audio&root=sound-effects`);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toMatchObject({ success: false, error: { code: 'RATE_LIMITED' } });
    expect(body.error.details.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('counts downloads separately from browsing', async () => {
    for (let i = 0; i < 3; i += 1) await fetch(`${base}/assets?kind=audio`);
    expect((await fetch(`${base}/assets/a1/download`, { method: 'POST' })).status).toBe(200);
    expect((await fetch(`${base}/assets/a1/download`, { method: 'POST' })).status).toBe(200);
    expect((await fetch(`${base}/assets/a1/download`, { method: 'POST' })).status).toBe(429);
  });
});

describe('public catalogue API with Redis down', () => {
  it('still answers when Redis is unreachable', async () => {
    const down = new FakeRedis();
    down.incr = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const { app, base } = await start(down);
    try {
      expect((await fetch(`${base}/assets?kind=audio`)).status).toBe(200);
      expect((await fetch(`${base}/assets/a1/download`, { method: 'POST' })).status).toBe(200);
    } finally {
      await app.close();
    }
  });
});
