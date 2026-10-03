import { HttpException } from '@nestjs/common';

import { GoogleVerifier } from './google-verifier';

const ticket = (payload: Record<string, unknown>) => ({ getPayload: () => payload });

function build(ids = ['web-1.apps.googleusercontent.com']) {
  const client = { verifyIdToken: jest.fn() };
  return { client, verifier: new GoogleVerifier({ googleClientIds: ids } as never, client as never) };
}

async function errorOf(p: Promise<unknown>): Promise<HttpException> {
  return p.then(
    () => {
      throw new Error('expected a failure');
    },
    (e: HttpException) => e,
  );
}

describe('GoogleVerifier', () => {
  it('checks the token against our client IDs and returns the Google ID and email', async () => {
    const { client, verifier } = build();
    client.verifyIdToken.mockResolvedValue(ticket({ sub: 'g-123', email: 'Ann@Gmail.com', email_verified: true }));
    await expect(verifier.verify('id-token')).resolves.toEqual({ sub: 'g-123', email: 'ann@gmail.com' });
    expect(client.verifyIdToken).toHaveBeenCalledWith({
      idToken: 'id-token',
      audience: ['web-1.apps.googleusercontent.com'],
    });
  });

  it('answers 503 when Google sign-in is not configured, without calling Google', async () => {
    const { client, verifier } = build([]);
    const error = await errorOf(verifier.verify('id-token'));
    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toMatchObject({ code: 'SIGN_IN_METHOD_UNAVAILABLE' });
    expect(client.verifyIdToken).not.toHaveBeenCalled();
  });

  it('answers 401 for a token Google does not vouch for', async () => {
    const { client, verifier } = build();
    client.verifyIdToken.mockRejectedValue(new Error('Wrong recipient, payload audience != requiredAudience'));
    const error = await errorOf(verifier.verify('id-token'));
    expect(error.getStatus()).toBe(401);
    expect(error.getResponse()).toMatchObject({ code: 'GOOGLE_TOKEN_INVALID' });
  });

  it.each([{ sub: 'g-1', email: 'ann@gmail.com', email_verified: false }, { sub: 'g-1' }])(
    'answers 422 without a verified email: %j',
    async (payload) => {
      const { client, verifier } = build();
      client.verifyIdToken.mockResolvedValue(ticket(payload));
      const error = await errorOf(verifier.verify('id-token'));
      expect(error.getStatus()).toBe(422);
      expect(error.getResponse()).toMatchObject({ code: 'GOOGLE_EMAIL_UNVERIFIED' });
    },
  );
});
