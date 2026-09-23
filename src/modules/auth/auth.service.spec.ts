import { UnauthorizedException } from '@nestjs/common';

import { AuthService } from './auth.service';
import { LoginAttemptService } from './login-attempt.service';
import { PasswordService } from './password.service';

const CTX = { ip: '1.2.3.4', userAgent: 'jest' };

function build(opts: { admin?: Record<string, unknown> | null; attempts?: number } = {}) {
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

  const settingsValues: Record<string, unknown> = {
    'auth.loginMaxAttempts': 5,
    'auth.loginLockoutSeconds': 900,
    'auth.bootstrapCompleted': false,
    'auth.jwtAccessSecret': 'seeded-secret-value-long-enough',
  };

  const settings = {
    get: jest.fn(async (k: string) => settingsValues[k]),
    // Mirrors the real SettingsService: `get` THROWS for an unset minLength
    // setting, so bootstrap must ask via isConfigured instead. A mock without
    // this method is what let the fresh-database boot failure ship unnoticed.
    isConfigured: jest.fn(async (k: string) => {
      const v = settingsValues[k];
      return typeof v === 'string' ? v.length > 0 : v !== undefined;
    }),
    set: jest.fn(async (k: string, v: unknown) => {
      settingsValues[k] = v;
    }),
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

  const attempts = new LoginAttemptService(
    settings as never,
    audit as never,
    redis as never,
  );

  const elevation = { revokeForAdmin: jest.fn(async () => undefined) };

  const svc = new AuthService(
    prisma as never,
    passwords,
    tokens as never,
    settings as never,
    audit as never,
    attempts,
    elevation as never,
  );

  return { svc, prisma, settings, redis, tokens, audit, passwords, elevation };
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
  it('creates the first owner when no admin exists', async () => {
    process.env.ADMIN_BOOTSTRAP_EMAIL = 'owner@example.com';
    process.env.ADMIN_BOOTSTRAP_PASSWORD = 'bootstrap-password-1';

    const { svc, prisma, settings } = build({ admin: null });
    await svc.bootstrap();

    expect(prisma.adminUser.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: 'owner@example.com', role: 'owner' }),
      }),
    );
    expect(settings.set).toHaveBeenCalledWith(
      'auth.bootstrapCompleted',
      true,
      'system',
    );

    delete process.env.ADMIN_BOOTSTRAP_EMAIL;
    delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
  });

  it('generates a jwt signing secret on first boot when none is set', async () => {
    const { svc, settings } = build({ admin: null });
    // A fresh database: the secret is absent. The real SettingsService THROWS
    // from `get` here rather than returning '', so bootstrap must detect absence
    // via isConfigured. Modelling it as `get -> ''` is what hid a boot failure.
    (settings.isConfigured as jest.Mock).mockImplementation(async (k: string) =>
      k === 'auth.jwtAccessSecret' ? false : true,
    );
    (settings.get as jest.Mock).mockImplementation(async (k: string) => {
      if (k === 'auth.jwtAccessSecret') {
        throw new Error(
          'auth.jwtAccessSecret is unset or too short (needs >= 32 characters).',
        );
      }
      return false;
    });

    await svc.bootstrap();

    const call = settings.set.mock.calls.find(
      ([k]: [string, unknown]) => k === 'auth.jwtAccessSecret',
    );
    expect(call).toBeDefined();
    expect(String(call![1]).length).toBeGreaterThanOrEqual(32);
  });

  it('does nothing when an admin already exists', async () => {
    const { svc, prisma } = build({ admin: { id: 'x' } });
    await svc.bootstrap();
    expect(prisma.adminUser.create).not.toHaveBeenCalled();
  });
});

describe('AuthService.logout', () => {
  // Spec 6.7: a grant is revoked on logout, not merely left to expire. Without
  // this, a 120-second write authorisation outlives the session that earned it
  // and expiry becomes the only control.
  it('revokes outstanding elevation grants as well as the token family', async () => {
    const admin = {
      id: 'admin-1',
      email: 'a@example.com',
      name: 'A',
      role: 'admin',
      isActive: true,
      deletedAt: null,
    };
    const { svc, prisma, tokens, elevation } = build({ admin });
    prisma.refreshToken.findUnique.mockResolvedValue({
      familyId: 'fam-1',
      adminUserId: 'admin-1',
    });

    await svc.logout('some-refresh-token');

    expect(tokens.revokeFamily).toHaveBeenCalledWith('fam-1');
    expect(elevation.revokeForAdmin).toHaveBeenCalledWith('admin-1');
  });
});
