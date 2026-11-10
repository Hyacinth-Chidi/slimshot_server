import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { configureHttp } from '../../app.setup';
import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { UserAuthGuard } from '../accounts/user-auth.guard';
import { CreditsController } from './credits.controller';
import { CreditsService } from './credits.service';

const ACCESS = 'Bearer a.b.c';
const QUOTE = { credits: 3, balance: 40, enough: true, pricingVersion: 2 };

// Stands in for UserAuthGuard: the real one is covered by its own spec.
const fakeGuard = {
  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string>; appUser?: unknown }>();
    if (req.headers.authorization !== ACCESS) {
      throw appError(401, ErrorCode.SIGN_IN_REQUIRED, 'Sign in to use this feature.');
    }
    req.appUser = { id: 'u1', sessionId: 's1', deviceId: 'dev-1', status: 'active' };
    return true;
  },
};

describe('credit quote over HTTP', () => {
  let app: INestApplication;
  let base: string;
  const credits = { quote: jest.fn(), history: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CreditsController],
      providers: [{ provide: CreditsService, useValue: credits }],
    })
      .overrideGuard(UserAuthGuard)
      .useValue(fakeGuard)
      .compile();

    app = moduleRef.createNestApplication();
    configureHttp(app);
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    credits.quote.mockReset().mockResolvedValue(QUOTE);
  });

  function quote(body: object) {
    return fetch(`${base}/api/app/v1/credits/quote`, {
      method: 'POST',
      headers: { authorization: ACCESS, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('quotes text to speech by characters', async () => {
    const res = await quote({ feature: 'text_to_speech', characters: 420 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: QUOTE });
    expect(credits.quote).toHaveBeenCalledWith('u1', 'text_to_speech', 420);
  });

  it('text to speech needs characters', async () => {
    expect((await quote({ feature: 'text_to_speech' })).status).toBe(422);
    expect((await quote({ feature: 'text_to_speech', characters: 0 })).status).toBe(422);
    expect((await quote({ feature: 'text_to_speech', characters: 20_001 })).status).toBe(422);
    expect((await quote({ feature: 'text_to_speech', characters: 2.5 })).status).toBe(422);
    expect(credits.quote).not.toHaveBeenCalled();
  });

  it('captions still need a duration', async () => {
    expect((await quote({ feature: 'auto_captions', characters: 5 })).status).toBe(422);
    const res = await quote({ feature: 'auto_captions', durationSeconds: 12.5 });
    expect(res.status).toBe(200);
    expect(credits.quote).toHaveBeenCalledWith('u1', 'auto_captions', 12.5);
  });
});
