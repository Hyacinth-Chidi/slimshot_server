import { ForbiddenException, UnauthorizedException } from '@nestjs/common';

import { PasswordService } from '../auth/password.service';
import { SettingsAdminService } from './settings-admin.service';

const CTX = { ip: '1.2.3.4', userAgent: 'test' };
const passwords = new PasswordService();

async function build(opts: { attempts?: number; isSecret?: boolean } = {}) {
  const hash = await passwords.hash('correct-password');
  const prisma = {
    adminUser: {
      findFirst: jest.fn(async () => ({
        id: 'admin-1',
        email: 'owner@example.com',
        passwordHash: hash,
        isActive: true,
        deletedAt: null,
      })),
    },
  };

  const settings = {
    revealSecret: jest.fn(async () => 'the-real-secret-value-1234567890'),
    set: jest.fn(async () => undefined),
    getMaskedGroup: jest.fn(async () => []),
  };

  const elevation = {
    issue: jest.fn(async () => 'grant-abc'),
    consume: jest.fn(async () => true),
  };

  let counter = opts.attempts ?? 0;
  const attempts = {
    assertNotLockedOut: jest.fn(async () => {
      if (counter >= 5) {
        throw new UnauthorizedException('Too many failed attempts. Try again later.');
      }
    }),
    recordFailure: jest.fn(async () => {
      counter += 1;
    }),
    clear: jest.fn(async () => {
      counter = 0;
    }),
  };

  const audit = { record: jest.fn(async (_entry: { action: string }) => undefined) };

  const svc = new SettingsAdminService(
    prisma as never,
    settings as never,
    elevation as never,
    passwords,
    audit as never,
    attempts as never,
  );

  return { svc, settings, elevation, audit, attempts };
}

describe('SettingsAdminService.reveal', () => {
  it('returns the value and a grant for a correct password', async () => {
    const { svc } = await build();
    const out = await svc.reveal('auth.jwtAccessSecret', 'admin-1', 'correct-password', CTX);

    expect(out.value).toBe('the-real-secret-value-1234567890');
    expect(out.grant).toBe('grant-abc');
    expect(out.expiresIn).toBe(120);
  });

  it('refuses a wrong password', async () => {
    const { svc } = await build();
    await expect(
      svc.reveal('auth.jwtAccessSecret', 'admin-1', 'wrong-password', CTX),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('never calls revealSecret when the password is wrong', async () => {
    const { svc, settings } = await build();
    await svc
      .reveal('auth.jwtAccessSecret', 'admin-1', 'wrong-password', CTX)
      .catch(() => undefined);

    expect(settings.revealSecret).not.toHaveBeenCalled();
  });

  it('refuses when the account is locked out, before checking the password', async () => {
    const { svc, settings, attempts } = await build({ attempts: 5 });
    await expect(
      svc.reveal('auth.jwtAccessSecret', 'admin-1', 'correct-password', CTX),
    ).rejects.toThrow(/too many/i);
    expect(settings.revealSecret).not.toHaveBeenCalled();
    expect(attempts.assertNotLockedOut).toHaveBeenCalledWith('owner@example.com');
  });

  it('counts a failed reveal against the same lockout as login', async () => {
    const { svc, attempts } = await build();
    await svc
      .reveal('auth.jwtAccessSecret', 'admin-1', 'wrong-password', CTX)
      .catch(() => undefined);

    // Without this, /reveal is an unthrottled password oracle against a known
    // owner address that never touches /auth/login.
    expect(attempts.recordFailure).toHaveBeenCalledWith(
      'owner@example.com',
      expect.objectContaining({ action: 'settings.reveal.failed' }),
      CTX,
    );
  });

  it('audits both success and failure, never recording the value', async () => {
    const { svc, audit } = await build();
    await svc.reveal('auth.jwtAccessSecret', 'admin-1', 'correct-password', CTX);
    await svc
      .reveal('auth.jwtAccessSecret', 'admin-1', 'wrong-password', CTX)
      .catch(() => undefined);

    const actions = audit.record.mock.calls.map(
      (c) => (c[0] as { action: string }).action,
    );
    expect(actions).toContain('settings.reveal.succeeded');
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(
      'the-real-secret-value',
    );
  });
});

describe('SettingsAdminService.update', () => {
  it('accepts a valid grant without a password', async () => {
    const { svc, settings } = await build();
    await svc.update(
      'auth.jwtAccessSecret',
      'new-value-12345678901234567890123',
      'admin-1',
      { grant: 'grant-abc' },
      CTX,
    );
    expect(settings.set).toHaveBeenCalled();
  });

  it('refuses when neither a password nor a grant is supplied for a secret', async () => {
    const { svc } = await build();
    await expect(
      svc.update('auth.jwtAccessSecret', 'x'.repeat(40), 'admin-1', {}, CTX),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses when the grant is rejected', async () => {
    const { svc, elevation } = await build();
    (elevation.consume as jest.Mock).mockResolvedValue(false);

    await expect(
      svc.update('auth.jwtAccessSecret', 'x'.repeat(40), 'admin-1', { grant: 'stale' }, CTX),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('updates a NON-secret setting with no password or grant', async () => {
    const { svc, settings } = await build();
    await svc.update('upload.audio.maxBytes', 1000, 'admin-1', {}, CTX);
    expect(settings.set).toHaveBeenCalled();
  });
});
