import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { configureHttp } from '../../app.setup';
import { AccountsService } from './accounts.service';
import { AppAuthController } from './app-auth.controller';

describe('app auth API over HTTP', () => {
  let app: INestApplication;
  let base: string;
  const accounts = {
    signInWithGoogle: jest.fn(async () => ({
      accessToken: 'a',
      refreshToken: 'r',
      expiresIn: 900,
      isNewAccount: true,
      needsClaim: true,
      user: { id: 'u1' },
    })),
    startEmail: jest.fn(async () => ({ sentTo: 'ann@example.com', resendAfterSeconds: 60, expiresInSeconds: 600 })),
    verifyEmail: jest.fn(),
    refresh: jest.fn(async () => ({ accessToken: 'a2', refreshToken: 'r2', expiresIn: 900 })),
    logout: jest.fn(async () => undefined),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AppAuthController],
      providers: [{ provide: AccountsService, useValue: accounts }],
    }).compile();
    app = moduleRef.createNestApplication();
    configureHttp(app);
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/api/app/v1/auth`;
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (path: string, body: unknown) =>
    fetch(`${base}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const DEVICE = 'device-token-good-000000';

  it('signs in with Google: 200 with tokens', async () => {
    const res = await post('google', { idToken: 'x'.repeat(40), deviceToken: DEVICE });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ accessToken: 'a', isNewAccount: true });
  });

  it('starts an email sign-in with a lowercased address', async () => {
    const res = await post('email/start', { email: 'Ann@Example.com', deviceToken: DEVICE });
    expect(res.status).toBe(200);
    expect(accounts.startEmail).toHaveBeenCalledWith('ann@example.com', DEVICE, expect.any(String));
  });

  it.each([
    ['google', { idToken: 'x'.repeat(40) }],
    ['email/start', { email: 'not-an-email', deviceToken: DEVICE }],
    ['email/verify', { email: 'ann@example.com', code: '12a456', deviceToken: DEVICE }],
  ])('422s an invalid %s request', async (path, body) => {
    const res = await post(path, body);
    expect(res.status).toBe(422);
  });

  it('refreshes and logs out with 200', async () => {
    expect((await post('refresh', { refreshToken: 'r'.repeat(64) })).status).toBe(200);
    const out = await post('logout', { refreshToken: 'r'.repeat(64) });
    expect(out.status).toBe(200);
    expect((await out.json()).data).toEqual({ loggedOut: true });
  });
});
