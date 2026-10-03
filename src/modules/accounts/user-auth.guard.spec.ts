import { ExecutionContext, HttpException } from '@nestjs/common';

import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { UserAuthGuard } from './user-auth.guard';

const JWT = 'aaa.bbb.ccc';

function contextWith(authorization?: string) {
  const req: { headers: Record<string, string | undefined>; appUser?: unknown } = { headers: { authorization } };
  return { req, ctx: { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext };
}

function build(
  session: Record<string, unknown> | null = {
    id: 's1',
    revokedAt: null,
    deviceId: 'dev-1',
    user: { id: 'u1', accountStatus: 'active' },
  },
) {
  const tokens = { verifyAccess: jest.fn(async () => ({ sub: 'u1', sid: 's1' })) };
  const prisma = { userSession: { findUnique: jest.fn(async () => session) } };
  return { tokens, guard: new UserAuthGuard(tokens as never, prisma as never) };
}

async function codeOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => 'passed',
    (e: HttpException) => (e.getResponse() as { code: string }).code,
  );
}

describe('UserAuthGuard', () => {
  it.each([undefined, 'Basic abc', 'Bearer', 'Bearer device-token-without-dots'])(
    'asks the user to sign in for %p',
    async (header) => {
      const { guard } = build();
      await expect(codeOf(guard.canActivate(contextWith(header).ctx))).resolves.toBe('SIGN_IN_REQUIRED');
    },
  );

  it('passes on an invalid or expired access token as UNAUTHENTICATED', async () => {
    const { guard, tokens } = build();
    tokens.verifyAccess.mockRejectedValue(appError(401, ErrorCode.UNAUTHENTICATED, 'Invalid or expired access token.'));
    await expect(codeOf(guard.canActivate(contextWith(`Bearer ${JWT}`).ctx))).resolves.toBe('UNAUTHENTICATED');
  });

  it.each([
    null,
    { id: 's1', revokedAt: new Date(), deviceId: 'dev-1', user: { id: 'u1', accountStatus: 'active' } },
    { id: 's1', revokedAt: null, deviceId: 'dev-1', user: { id: 'u1', accountStatus: 'deleted' } },
    { id: 's1', revokedAt: null, deviceId: 'dev-1', user: { id: 'someone-else', accountStatus: 'active' } },
  ])('ends a session that is gone, revoked, deleted or not theirs: %j', async (session) => {
    const { guard } = build(session);
    await expect(codeOf(guard.canActivate(contextWith(`Bearer ${JWT}`).ctx))).resolves.toBe('UNAUTHENTICATED');
  });

  it('attaches the user, including a suspended one', async () => {
    const { guard } = build({ id: 's1', revokedAt: null, deviceId: 'dev-1', user: { id: 'u1', accountStatus: 'suspended' } });
    const { req, ctx } = contextWith(`Bearer ${JWT}`);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.appUser).toEqual({ id: 'u1', sessionId: 's1', deviceId: 'dev-1', status: 'suspended' });
  });
});
