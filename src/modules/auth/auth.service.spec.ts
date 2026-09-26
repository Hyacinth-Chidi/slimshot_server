import { UnauthorizedException } from '@nestjs/common';

import { AuthService } from './auth.service';
import { LoginAttemptService } from './login-attempt.service';
import { PasswordService } from './password.service';

const CTX = { ip: '1.2.3.4', userAgent: 'jest' };

function build(
  opts: {
    admin?: Record<string, unknown> | null;
    attempts?: number;
    bootstrap?: { email: string; password: string } | null;
  } = {},
) {
  const passwords = new PasswordService();

  const prisma = {
    adminUser: {
      findFirst: jest.fn(async () => opts.admin ?? null),
      count: jest.fn(async () => (opts.admin ? 1 : 0)),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'new-admin',
        ...data,
      })),
      update: jest.fn(async () => ({})),
    },
    refreshToken: {
      updateMany: jest.fn(async () => ({ count: 1 })),
      findUnique: jest.fn(async (): Promise<Record<string, unknown> | null> => null),
    },
  };

  const config = {
    jwt: { accessSecret: 'x'.repeat(40), accessTtlSeconds: 900, refreshTtlSeconds: 604_800 },
    login: { maxAttempts: 5, lockoutSeconds: 900 },
    bootstrap: opts.bootstrap ?? null,
  };

  let counter = opts.attempts ?? 0;
  const redis = {
    incr: jest.fn(async () => (counter += 1)),
    expire: jest.fn(async () => 1),
    get: jest.fn(async () => String(counter)),
    del: jest.fn(async () => {
      counter = 0;
      return 1;
    }),
  };

  const tokens = {
    issuePair: jest.fn(async () => ({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresIn: 900,
    })),
    rotate: jest.fn(async () => ({
      accessToken: 'at2',
      refreshToken: 'rt2',
      expiresIn: 900,
    })),
    revokeFamily: jest.fn(async () => undefined),
  };

  const audit = { record: jest.fn(async () => undefined) };

  const attempts = new LoginAttemptService(config, audit as never, redis as never);

  const svc = new AuthService(
    prisma as never,
    passwords,
    tokens as never,
    audit as never,
    attempts,
    config,
  );

  return { svc, prisma, redis, tokens, audit, passwords };
}

describe('AuthService.login', () => {
  it('returns a token pair for correct credentials', async () => {
    const passwords = new PasswordService();
    const admin = {
      id: 'admin-1',
      email: 'a@example.com',
      name: 'A',
      role: 'admin',
      isActive: true,
      deletedAt: null,
      passwordHash: await passwords.hash('correct-password'),
    };

    const { svc } = build({ admin });
    await expect(
      svc.login({ email: 'a@example.com', password: 'correct-password' }, CTX),
    ).resolves.toMatchObject({ accessToken: 'at' });
  });

  it('rejects a wrong password', async () => {
    const passwords = new PasswordService();
    const admin = {
      id: 'admin-1',
      email: 'a@example.com',
      name: 'A',
      role: 'admin',
      isActive: true,
      deletedAt: null,
      passwordHash: await passwords.hash('correct-password'),
    };

    const { svc } = build({ admin });
    await expect(
      svc.login({ email: 'a@example.com', password: 'wrong' }, CTX),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('gives the same error for unknown email as for wrong password', async () => {
    const { svc } = build({ admin: null });
    await expect(
      svc.login({ email: 'nobody@example.com', password: 'whatever12' }, CTX),
    ).rejects.toThrow('Invalid email or password.');
  });

  it('refuses a deactivated account', async () => {
    const passwords = new PasswordService();
    const admin = {
      id: 'admin-1',
      email: 'a@example.com',
      name: 'A',
      role: 'admin',
      isActive: false,
      deletedAt: null,
      passwordHash: await passwords.hash('correct-password'),
    };

    const { svc } = build({ admin });
    await expect(
      svc.login({ email: 'a@example.com', password: 'correct-password' }, CTX),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('locks out after the configured number of failures', async () => {
    const { svc } = build({ admin: null, attempts: 5 });
    await expect(
      svc.login({ email: 'a@example.com', password: 'whatever12' }, CTX),
    ).rejects.toThrow(/too many/i);
  });

  it('clears the failure counter after a successful login', async () => {
    const passwords = new PasswordService();
    const admin = {
      id: 'admin-1',
      email: 'a@example.com',
      name: 'A',
      role: 'admin',
      isActive: true,
      deletedAt: null,
      passwordHash: await passwords.hash('correct-password'),
    };

    const { svc, redis } = build({ admin });
    await svc.login({ email: 'a@example.com', password: 'correct-password' }, CTX);
    expect(redis.del).toHaveBeenCalled();
  });

  it('audits a failed login attempt', async () => {
    const { svc, audit } = build({ admin: null });
    await svc
      .login({ email: 'a@example.com', password: 'whatever12' }, CTX)
      .catch(() => undefined);

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.login.failed' }),
    );
  });

  it('never puts the password in the audit record', async () => {
    const { svc, audit } = build({ admin: null });
    await svc
      .login({ email: 'a@example.com', password: 'hunter2xyz' }, CTX)
      .catch(() => undefined);

    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('hunter2xyz');
  });
});

describe('AuthService.bootstrap', () => {
  it('creates the first owner from the configured credentials when no admin exists', async () => {
    const { svc, prisma } = build({
      admin: null,
      bootstrap: { email: 'Owner@Example.com', password: 'bootstrap-password-1' },
    });
    await svc.bootstrap();

    expect(prisma.adminUser.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: 'owner@example.com', role: 'owner' }),
      }),
    );
  });

  it('creates nothing when no bootstrap credentials are configured', async () => {
    const { svc, prisma } = build({ admin: null, bootstrap: null });
    await svc.bootstrap();
    expect(prisma.adminUser.create).not.toHaveBeenCalled();
  });

  it('does nothing when an admin already exists', async () => {
    const { svc, prisma } = build({ admin: { id: 'x' } });
    await svc.bootstrap();
    expect(prisma.adminUser.create).not.toHaveBeenCalled();
  });
});

describe('AuthService.logout', () => {
  it('revokes the token family', async () => {
    const admin = {
      id: 'admin-1',
      email: 'a@example.com',
      name: 'A',
      role: 'admin',
      isActive: true,
      deletedAt: null,
    };
    const { svc, prisma, tokens } = build({ admin });
    prisma.refreshToken.findUnique.mockResolvedValue({
      familyId: 'fam-1',
      adminUserId: 'admin-1',
    });

    await svc.logout('some-refresh-token');

    expect(tokens.revokeFamily).toHaveBeenCalledWith('fam-1');
  });
});
