import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';

import { TokenService } from './token.service';

const ADMIN = {
  id: 'admin-1',
  email: 'a@example.com',
  role: 'admin' as const,
};

function settingsMock() {
  const values: Record<string, unknown> = {
    'auth.accessTokenTtlSeconds': 900,
    'auth.refreshTokenTtlSeconds': 604_800,
    'auth.jwtAccessSecret': 'test-signing-secret-that-is-long-enough',
  };
  return { get: jest.fn(async (k: string) => values[k]) };
}

function prismaMock() {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    refreshToken: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        rows.push(data);
        return data;
      }),
      findUnique: jest.fn(async ({ where }: { where: { tokenHash: string } }) =>
        rows.find((r) => r.tokenHash === where.tokenHash) ?? null,
      ),
      update: jest.fn(async ({ where, data }: { where: { tokenHash: string }; data: Record<string, unknown> }) => {
        const row = rows.find((r) => r.tokenHash === where.tokenHash);
        if (row) Object.assign(row, data);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: { familyId: string }; data: Record<string, unknown> }) => {
        let count = 0;
        for (const r of rows) {
          if (r.familyId === where.familyId && !r.revokedAt) {
            Object.assign(r, data);
            count += 1;
          }
        }
        return { count };
      }),
    },
  };
}

function build() {
  const prisma = prismaMock();
  const settings = settingsMock();
  const svc = new TokenService(prisma as never, settings as never, new JwtService({}));
  return { svc, prisma, settings };
}

const CTX = { ip: '1.2.3.4', userAgent: 'jest' };

describe('TokenService', () => {
  it('issues an access token carrying the admin id, email and role', async () => {
    const { svc } = build();
    const pair = await svc.issuePair(ADMIN, CTX);
    const claims = await svc.verifyAccessToken(pair.accessToken);

    expect(claims.sub).toBe('admin-1');
    expect(claims.email).toBe('a@example.com');
    expect(claims.role).toBe('admin');
  });

  it('stores only a hash of the refresh token, never the token itself', async () => {
    const { svc, prisma } = build();
    const pair = await svc.issuePair(ADMIN, CTX);

    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0].tokenHash).not.toBe(pair.refreshToken);
    expect(JSON.stringify(prisma.rows[0])).not.toContain(pair.refreshToken);
  });

  it('rotation issues a new pair and revokes the presented token', async () => {
    const { svc, prisma } = build();
    const first = await svc.issuePair(ADMIN, CTX);
    const second = await svc.rotate(first.refreshToken, CTX);

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(prisma.rows[0].revokedAt).toBeTruthy();
  });

  it('keeps the rotated token in the same family', async () => {
    const { svc, prisma } = build();
    const first = await svc.issuePair(ADMIN, CTX);
    await svc.rotate(first.refreshToken, CTX);

    expect(prisma.rows[1].familyId).toBe(prisma.rows[0].familyId);
  });

  it('reusing a revoked refresh token revokes the whole family', async () => {
    const { svc, prisma } = build();
    const first = await svc.issuePair(ADMIN, CTX);
    await svc.rotate(first.refreshToken, CTX);

    await expect(svc.rotate(first.refreshToken, CTX)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(prisma.rows.every((r) => r.revokedAt)).toBe(true);
  });

  it('rejects an unknown refresh token', async () => {
    const { svc } = build();
    await expect(svc.rotate('never-issued', CTX)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects an expired refresh token', async () => {
    const { svc, prisma } = build();
    const pair = await svc.issuePair(ADMIN, CTX);
    prisma.rows[0].expiresAt = new Date(Date.now() - 1000);

    await expect(svc.rotate(pair.refreshToken, CTX)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a tampered access token', async () => {
    const { svc } = build();
    const pair = await svc.issuePair(ADMIN, CTX);
    await expect(svc.verifyAccessToken(`${pair.accessToken}x`)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('reports the access token ttl so clients can schedule refresh', async () => {
    const { svc } = build();
    await expect(svc.issuePair(ADMIN, CTX)).resolves.toMatchObject({ expiresIn: 900 });
  });
});
