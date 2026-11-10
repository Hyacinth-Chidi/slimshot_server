import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { FakeRedis } from '../../../test/fakes/fake-redis';
import { configureHttp } from '../../app.setup';
import { REDIS } from '../../core/cache/cache.service';
import { IdentityHashService } from '../../core/identity/identity-hash.service';
import { RateLimiter } from '../../core/rate-limit/rate-limiter';
import { CATALOG_LIMITS } from '../catalog/catalog-limits';
import { VoicesController } from './voices.controller';
import { VoicesService } from './voices.service';

const VOICES = [{ id: 'v1', label: 'Eve', sampleUrl: 'https://cdn.test/slimshot/voices/samples/a.mp3' }];

async function start(redis: unknown) {
  const voices = { listForApp: jest.fn(async () => VOICES) };
  const moduleRef = await Test.createTestingModule({
    controllers: [VoicesController],
    providers: [
      RateLimiter,
      { provide: REDIS, useValue: redis },
      { provide: VoicesService, useValue: voices },
      { provide: IdentityHashService, useValue: { hash: (_kind: string, value: string) => value } },
      { provide: CATALOG_LIMITS, useValue: { readPerMinute: 2, downloadPerMinute: 2 } },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  configureHttp(app);
  await app.listen(0, '127.0.0.1');
  return { app, voices, base: `${await app.getUrl()}/api/app/v1/voices` };
}

describe("the app's voices over HTTP", () => {
  let app: INestApplication;
  let base: string;

  beforeEach(async () => {
    ({ app, base } = await start(new FakeRedis()));
  });

  afterEach(async () => {
    await app.close();
  });

  it('lists the voices without sign-in', async () => {
    const res = await fetch(base);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: VOICES });
  });

  it('too many requests from one address are refused, saying when to retry', async () => {
    for (let i = 0; i < 2; i += 1) expect((await fetch(base)).status).toBe(200);
    const res = await fetch(base);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toMatchObject({ success: false, error: { code: 'RATE_LIMITED' } });
    expect(body.error.details.retryAfterSeconds).toBeGreaterThan(0);
  });
});
