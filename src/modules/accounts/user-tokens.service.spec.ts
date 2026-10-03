import { HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { UserTokensService } from './user-tokens.service';

interface Session {
  id: string;
  userId: string;
  deviceId: string;
  revokedAt: Date | null;
  lastUsedAt: Date;
}
interface Token {
  id: string;
  tokenHash: string;
  sessionId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

function build() {
  const sessions = new Map<string, Session>();
  const tokens = new Map<string, Token>();
  const users = new Map([['u1', { id: 'u1', accountStatus: 'active' }]]);
  let seq = 0;
  const matchToken = (t: Token, where: Record<string, unknown>) =>
    (where.id === undefined || t.id === where.id) &&
    (where.sessionId === undefined || t.sessionId === where.sessionId) &&
    t.revokedAt === null;
  const prisma = {
    userSession: {
      create: jest.fn(async ({ data }: { data: { userId: string; deviceId: string } }) => {
        const s: Session = { id: `s${(seq += 1)}`, revokedAt: null, lastUsedAt: new Date(), ...data };
        sessions.set(s.id, s);
        return { id: s.id };
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Session> }) =>
        Object.assign(sessions.get(where.id) as Session, data),
      ),
      updateMany: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Session> }) => {
        const s = sessions.get(where.id);
        if (!s || s.revokedAt) return { count: 0 };
        Object.assign(s, data);
        return { count: 1 };
      }),
    },
    userRefreshToken: {
      create: jest.fn(async ({ data }: { data: Omit<Token, 'id' | 'revokedAt'> }) => {
        const t: Token = { id: `t${(seq += 1)}`, revokedAt: null, ...data };
        tokens.set(t.tokenHash, t);
        return t;
      }),
      findUnique: jest.fn(async ({ where }: { where: { tokenHash: string } }) => {
        const t = tokens.get(where.tokenHash);
        if (!t) return null;
        const s = sessions.get(t.sessionId) as Session;
        return { ...t, session: { ...s, user: users.get(s.userId) } };
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Token> }) => {
        let count = 0;
        for (const t of tokens.values()) {
          if (matchToken(t, where)) {
            Object.assign(t, data);
            count += 1;
          }
        }
        return { count };
      }),
    },
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const svc = new UserTokensService(
    prisma as never,
    { jwtSecret: 'u'.repeat(48), accessTtlSeconds: 900, refreshTtlSeconds: 2_592_000 } as never,
    new JwtService({}),
  );
  return { svc, sessions, tokens, users };
}

async function errorOf(p: Promise<unknown>): Promise<HttpException> {
  return p.then(
    () => {
      throw new Error('expected a failure');
    },
    (e: HttpException) => e,
  );
}

describe('UserTokensService', () => {
  it('starts a session with an app access token and a hashed refresh token', async () => {
    const { svc, tokens } = build();
    const pair = await svc.startSession('u1', 'dev-1');
    expect(pair.expiresIn).toBe(900);
    await expect(svc.verifyAccess(pair.accessToken)).resolves.toMatchObject({ sub: 'u1', sid: 's1' });
    expect([...tokens.keys()]).not.toContain(pair.refreshToken);
  });

  it('rejects tokens signed with another secret or for another audience', async () => {
    const { svc } = build();
    const jwt = new JwtService({});
    const otherSecret = await jwt.signAsync({ sub: 'u1', sid: 's1' }, { secret: 's'.repeat(48), audience: 'slimshot-app' });
    const noAudience = await jwt.signAsync({ sub: 'u1', sid: 's1' }, { secret: 'u'.repeat(48) });
    for (const token of [otherSecret, noAudience]) {
      expect((await errorOf(svc.verifyAccess(token))).getResponse()).toMatchObject({ code: 'UNAUTHENTICATED' });
    }
  });

  it('rotates a refresh token and refuses the old one afterwards, ending the session', async () => {
    const { svc, sessions } = build();
    const first = await svc.startSession('u1', 'dev-1');
    const second = await svc.rotate(first.refreshToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);

    const reuse = await errorOf(svc.rotate(first.refreshToken));
    expect(reuse.getStatus()).toBe(401);
    expect(sessions.get('s1')?.revokedAt).not.toBeNull();
    await expect(svc.rotate(second.refreshToken)).rejects.toBeInstanceOf(HttpException);
  });

  it('lets at most one of two simultaneous refreshes through', async () => {
    const { svc } = build();
    const pair = await svc.startSession('u1', 'dev-1');
    const results = await Promise.allSettled([svc.rotate(pair.refreshToken), svc.rotate(pair.refreshToken)]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeLessThanOrEqual(1);
  });

  it('refuses an expired refresh token', async () => {
    const { svc, tokens } = build();
    const pair = await svc.startSession('u1', 'dev-1');
    for (const t of tokens.values()) t.expiresAt = new Date(Date.now() - 1);
    expect((await errorOf(svc.rotate(pair.refreshToken))).getStatus()).toBe(401);
  });

  it("refuses a deleted user's refresh token", async () => {
    const { svc, users } = build();
    const pair = await svc.startSession('u1', 'dev-1');
    users.set('u1', { id: 'u1', accountStatus: 'deleted' });
    expect((await errorOf(svc.rotate(pair.refreshToken))).getStatus()).toBe(401);
  });

  it('logs out by ending the session; an unknown token is ignored', async () => {
    const { svc, sessions } = build();
    const pair = await svc.startSession('u1', 'dev-1');
    await svc.logout(pair.refreshToken);
    expect(sessions.get('s1')?.revokedAt).not.toBeNull();
    await expect(svc.logout('unknown-token-value-0000')).resolves.toBeUndefined();
  });
});
