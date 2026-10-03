import { HttpException } from '@nestjs/common';

import { FakeRedis } from '../../../test/fakes/fake-redis';
import { IdentityHashService } from '../../core/identity/identity-hash.service';
import { RateLimiter } from '../../core/rate-limit/rate-limiter';
import { AccountsService } from './accounts.service';

interface Row {
  id: string;
  email: string | null;
  googleSub: string | null;
  claimedAt: Date | null;
  signupIpLimited?: boolean;
  referralCode?: string;
}

const DEVICE = 'device-token-good-000000';

function build(rows: Row[] = [], opts: { ipLimit?: number } = {}) {
  let seq = rows.length;
  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where }: { where: { email?: string; googleSub?: string } }) =>
        rows.find((r) => (where.email !== undefined ? r.email === where.email : r.googleSub === where.googleSub)) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: Omit<Row, 'id' | 'claimedAt' | 'googleSub'> & { googleSub?: string } }) => {
        const row: Row = { id: `u${(seq += 1)}`, claimedAt: null, googleSub: null, ...data };
        rows.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) =>
        Object.assign(rows.find((r) => r.id === where.id) as Row, data),
      ),
    },
    device: { update: jest.fn(async () => undefined) },
  };
  const devices = { authenticate: jest.fn(async (t: string) => (t === DEVICE ? { id: 'dev-1' } : null)) };
  const tokens = {
    startSession: jest.fn(async () => ({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 })),
    rotate: jest.fn(),
    logout: jest.fn(),
  };
  const otp = {
    send: jest.fn(async () => ({ resendAfterSeconds: 60, expiresInSeconds: 600 })),
    verify: jest.fn(async () => undefined),
  };
  const google = { verify: jest.fn(async () => ({ sub: 'g-1', email: 'ann@gmail.com' })) };
  const settings = {
    get: jest.fn(async () => ({ disposableEmailDomains: ['mailinator.com'], ipSignupLimitPer24h: opts.ipLimit ?? 10 })),
  };
  const hashes = new IdentityHashService({ identityHmacSecret: 'h'.repeat(48) } as never);
  const me = { view: jest.fn(async (id: string) => ({ id })) };
  const svc = new AccountsService(
    prisma as never,
    devices as never,
    tokens as never,
    otp as never,
    google as never,
    settings as never,
    new RateLimiter(new FakeRedis() as never),
    hashes,
    me as never,
  );
  return { svc, rows, prisma, tokens, otp, google };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => 'passed',
    (e: HttpException) => (e.getResponse() as { code: string }).code,
  );
}

describe('AccountsService — Google', () => {
  it('creates an account for a new Google user and links the install', async () => {
    const { svc, rows, prisma, tokens } = build();
    const res = await svc.signInWithGoogle('id-token', DEVICE, '10.0.0.1');
    expect(res).toMatchObject({ isNewAccount: true, needsClaim: true, accessToken: 'a', user: { id: 'u1' } });
    expect(rows[0]).toMatchObject({ email: 'ann@gmail.com', googleSub: 'g-1', signupIpLimited: false });
    expect(rows[0].referralCode).toMatch(/^[A-Z2-9]{8}$/);
    expect(prisma.device.update).toHaveBeenCalledWith({ where: { id: 'dev-1' }, data: { userId: 'u1' } });
    expect(tokens.startSession).toHaveBeenCalledWith('u1', 'dev-1');
  });

  it('signs an existing Google user back in', async () => {
    const { svc, prisma } = build([{ id: 'u9', email: 'ann@gmail.com', googleSub: 'g-1', claimedAt: new Date() }]);
    await expect(svc.signInWithGoogle('id-token', DEVICE)).resolves.toMatchObject({ isNewAccount: false, needsClaim: false });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('links Google to an existing email account', async () => {
    const { svc, rows } = build([{ id: 'u9', email: 'ann@gmail.com', googleSub: null, claimedAt: null }]);
    await svc.signInWithGoogle('id-token', DEVICE);
    expect(rows[0].googleSub).toBe('g-1');
  });

  it('refuses an email already linked to a different Google account', async () => {
    const { svc } = build([{ id: 'u9', email: 'ann@gmail.com', googleSub: 'g-OTHER', claimedAt: null }]);
    await expect(codeOf(svc.signInWithGoogle('id-token', DEVICE))).resolves.toBe('ACCOUNT_LINK_CONFLICT');
  });

  it('refuses an unregistered install before asking Google', async () => {
    const { svc, google } = build();
    await expect(codeOf(svc.signInWithGoogle('id-token', 'unknown-device-token-00'))).resolves.toBe('DEVICE_NOT_REGISTERED');
    expect(google.verify).not.toHaveBeenCalled();
  });

  it('ends a parallel sign-up for the same email on one account', async () => {
    const { svc, rows, prisma } = build();
    prisma.user.create.mockImplementationOnce(async () => {
      rows.push({ id: 'u7', email: 'ann@gmail.com', googleSub: 'g-1', claimedAt: null });
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    });
    await expect(svc.signInWithGoogle('id-token', DEVICE)).resolves.toMatchObject({ isNewAccount: false, user: { id: 'u7' } });
    expect(rows).toHaveLength(1);
  });
});

describe('AccountsService — email code', () => {
  it('sends a code scoped to the install and IP', async () => {
    const { svc, otp } = build();
    await expect(svc.startEmail(' Ann@Example.com ', DEVICE, '10.0.0.1')).resolves.toEqual({
      sentTo: 'ann@example.com',
      resendAfterSeconds: 60,
      expiresInSeconds: 600,
    });
    expect(otp.send).toHaveBeenCalledWith('sign_in', 'ann@example.com', { installId: 'dev-1', ip: '10.0.0.1' });
  });

  it('refuses a disposable address', async () => {
    const { svc, otp } = build();
    await expect(codeOf(svc.startEmail('x@mailinator.com', DEVICE))).resolves.toBe('EMAIL_DOMAIN_NOT_ALLOWED');
    expect(otp.send).not.toHaveBeenCalled();
  });

  it('creates the account once the code checks out', async () => {
    const { svc, rows, otp } = build();
    await expect(svc.verifyEmail('ann@example.com', '123456', DEVICE)).resolves.toMatchObject({ isNewAccount: true });
    expect(otp.verify).toHaveBeenCalledWith('sign_in', 'ann@example.com', '123456');
    expect(rows[0].email).toBe('ann@example.com');
  });

  it('creates nothing when the code is wrong', async () => {
    const { svc, rows, otp } = build();
    otp.verify.mockRejectedValue(new Error('OTP_INVALID'));
    await expect(svc.verifyEmail('ann@example.com', '000000', DEVICE)).rejects.toThrow('OTP_INVALID');
    expect(rows).toHaveLength(0);
  });

  it('marks accounts past the per-IP daily limit', async () => {
    const { svc, rows } = build([], { ipLimit: 2 });
    for (const n of [1, 2, 3]) await svc.verifyEmail(`p${n}@example.com`, '123456', DEVICE, '10.0.0.9');
    expect(rows.map((r) => r.signupIpLimited)).toEqual([false, false, true]);
  });
});
