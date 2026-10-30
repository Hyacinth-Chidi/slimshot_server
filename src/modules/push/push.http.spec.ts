import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { configureHttp } from '../../app.setup';
import { PushController } from './push.controller';
import { PushService } from './push.service';

describe('app push API over HTTP', () => {
  let app: INestApplication;
  let base: string;
  const push = { setToken: jest.fn(async (_device: string, token: string | null) => ({ registered: token !== null })) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PushController],
      providers: [{ provide: PushService, useValue: push }],
    }).compile();
    app = moduleRef.createNestApplication();
    configureHttp(app);
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/api/app/v1/push/token`;
  });

  afterAll(async () => {
    await app.close();
  });

  const put = (body: unknown) =>
    fetch(base, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('stores an install’s token, without sign-in', async () => {
    const res = await put({ deviceToken: 'install-token-123', token: 'f'.repeat(140) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { registered: true } });
    expect(push.setToken).toHaveBeenLastCalledWith('install-token-123', 'f'.repeat(140));
  });

  it('clears it with a null token', async () => {
    const res = await put({ deviceToken: 'install-token-123', token: null });
    expect(await res.json()).toEqual({ success: true, data: { registered: false } });
    expect(push.setToken).toHaveBeenLastCalledWith('install-token-123', null);
  });

  it.each([[{ token: 'f'.repeat(140) }], [{ deviceToken: 'install-token-123' }], [{ deviceToken: 'install-token-123', token: 42 }], [{ deviceToken: 'x', token: 'f'.repeat(5000) }]])(
    '422s %j',
    async (body) => {
      expect((await put(body)).status).toBe(422);
    },
  );
});
