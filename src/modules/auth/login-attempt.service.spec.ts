import { UnauthorizedException } from '@nestjs/common';

import { LoginAttemptService } from './login-attempt.service';

const CTX = { ip: '1.2.3.4', userAgent: 'jest' };

function build(opts: { attempts?: number } = {}) {
  const settingsValues: Record<string, unknown> = {
    'auth.loginMaxAttempts': 5,
    'auth.loginLockoutSeconds': 900,
  };

  const settings = {
    get: jest.fn(async (k: string) => settingsValues[k]),
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

  const audit = { record: jest.fn(async () => undefined) };

  const svc = new LoginAttemptService(settings as never, audit as never, redis as never);

  return { svc, settings, redis, audit };
}

describe('LoginAttemptService', () => {
  it('does not throw when under the attempt limit', async () => {
    const { svc } = build({ attempts: 0 });
    await expect(svc.assertNotLockedOut('a@example.com')).resolves.toBeUndefined();
  });

  it('throws when the attempt limit has been reached', async () => {
    const { svc } = build({ attempts: 5 });
    await expect(svc.assertNotLockedOut('a@example.com')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('increments and expires the shared login-fail counter on failure', async () => {
    const { svc, redis } = build();
    await svc.recordFailure(
      'a@example.com',
      { action: 'auth.login.failed', entityType: 'AdminUser' },
      CTX,
    );

    expect(redis.incr).toHaveBeenCalledWith('auth:login:fail:a@example.com');
    expect(redis.expire).toHaveBeenCalledWith('auth:login:fail:a@example.com', 900);
  });

  it('lowercases the email in the shared key', async () => {
    const { svc, redis } = build();
    await svc.recordFailure(
      'Mixed-Case@Example.com',
      { action: 'auth.login.failed', entityType: 'AdminUser' },
      CTX,
    );

    expect(redis.incr).toHaveBeenCalledWith('auth:login:fail:mixed-case@example.com');
  });

  it('records an audit entry with the given action on failure', async () => {
    const { svc, audit } = build();
    await svc.recordFailure(
      'a@example.com',
      { action: 'settings.reveal.failed', entityType: 'SystemSetting', entityId: 'auth.jwtAccessSecret' },
      CTX,
    );

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'settings.reveal.failed',
        entityType: 'SystemSetting',
        entityId: 'auth.jwtAccessSecret',
        after: { email: 'a@example.com' },
        ip: CTX.ip,
        userAgent: CTX.userAgent,
      }),
    );
  });

  it('clears the counter', async () => {
    const { svc, redis } = build({ attempts: 3 });
    await svc.clear('a@example.com');
    expect(redis.del).toHaveBeenCalledWith('auth:login:fail:a@example.com');
  });
});
