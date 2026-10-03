import { HttpException } from '@nestjs/common';

import { FakeRedis } from '../../../test/fakes/fake-redis';
import { IdentityHashService } from '../../core/identity/identity-hash.service';
import { RateLimiter } from '../../core/rate-limit/rate-limiter';
import { OtpService } from './otp.service';

const LIMITS = {
  otpMaxAttempts: 5,
  otpResendCooldownSeconds: 60,
  otpPerEmailPerHour: 5,
  otpPerDevicePerHour: 10,
  otpPerIpPerHour: 20,
};

interface Sent {
  to: string;
  subject: string;
  text: string;
}

function build(overrides: Partial<typeof LIMITS> = {}) {
  const redis = new FakeRedis();
  let t = 1_000_000;
  redis.now = () => t;
  const hashes = new IdentityHashService({ identityHmacSecret: 'h'.repeat(48) } as never);
  const settings = { get: jest.fn(async () => ({ ...LIMITS, ...overrides })) };
  const sent: Sent[] = [];
  const email = { send: jest.fn(async (m: Sent) => void sent.push(m)) };
  const otp = new OtpService(redis as never, hashes, settings as never, new RateLimiter(redis as never), email);
  return {
    otp,
    redis,
    sent,
    codeOf: () => /\b(\d{6})\b/.exec(sent[sent.length - 1].text)?.[1] ?? '',
    advance: (seconds: number) => {
      t += seconds * 1000;
    },
  };
}

async function errorOf(p: Promise<unknown>): Promise<HttpException> {
  return p.then(
    () => {
      throw new Error('expected a failure');
    },
    (e: HttpException) => e,
  );
}

describe('OtpService', () => {
  it('emails a 6-digit code and stores only its hash', async () => {
    const { otp, redis, sent, codeOf } = build();
    await expect(otp.send('sign_in', 'ann@example.com', {})).resolves.toEqual({
      resendAfterSeconds: 60,
      expiresInSeconds: 600,
    });
    expect(sent[0].to).toBe('ann@example.com');
    expect(codeOf()).toMatch(/^\d{6}$/);
    expect(redis.values().join(' ')).not.toContain(codeOf());
  });

  it('accepts the right code once', async () => {
    const { otp, codeOf } = build();
    await otp.send('sign_in', 'ann@example.com', {});
    const code = codeOf();
    await expect(otp.verify('sign_in', 'ann@example.com', code)).resolves.toBeUndefined();
    expect((await errorOf(otp.verify('sign_in', 'ann@example.com', code))).getResponse()).toMatchObject({
      code: 'OTP_EXPIRED',
    });
  });

  it('expires after 10 minutes', async () => {
    const { otp, codeOf, advance } = build();
    await otp.send('sign_in', 'ann@example.com', {});
    advance(601);
    const error = await errorOf(otp.verify('sign_in', 'ann@example.com', codeOf()));
    expect(error.getStatus()).toBe(422);
    expect(error.getResponse()).toMatchObject({ code: 'OTP_EXPIRED' });
  });

  it('counts wrong codes and kills the code on the fifth', async () => {
    const { otp, codeOf } = build();
    await otp.send('sign_in', 'ann@example.com', {});
    const right = codeOf();
    const wrong = right === '000000' ? '111111' : '000000';

    const first = await errorOf(otp.verify('sign_in', 'ann@example.com', wrong));
    expect(first.getStatus()).toBe(422);
    expect(first.getResponse()).toMatchObject({ code: 'OTP_INVALID', details: { attemptsLeft: 4 } });
    for (let i = 0; i < 3; i += 1) await otp.verify('sign_in', 'ann@example.com', wrong).catch(() => undefined);
    const fifth = await errorOf(otp.verify('sign_in', 'ann@example.com', wrong));
    expect(fifth.getStatus()).toBe(429);
    expect(fifth.getResponse()).toMatchObject({ code: 'OTP_ATTEMPTS_EXCEEDED' });
    expect((await errorOf(otp.verify('sign_in', 'ann@example.com', right))).getResponse()).toMatchObject({
      code: 'OTP_EXPIRED',
    });
  });

  it('enforces the resend cooldown', async () => {
    const { otp, advance } = build();
    await otp.send('sign_in', 'ann@example.com', {});
    const error = await errorOf(otp.send('sign_in', 'ann@example.com', {}));
    expect(error.getStatus()).toBe(429);
    expect(error.getResponse()).toMatchObject({ code: 'OTP_RESEND_TOO_SOON', details: { retryAfterSeconds: 60 } });
    advance(61);
    await expect(otp.send('sign_in', 'ann@example.com', {})).resolves.toBeDefined();
  });

  it('limits codes per email per hour', async () => {
    const { otp } = build({ otpResendCooldownSeconds: 0, otpPerEmailPerHour: 2 });
    await otp.send('sign_in', 'ann@example.com', {});
    await otp.send('sign_in', 'ann@example.com', {});
    expect((await errorOf(otp.send('sign_in', 'ann@example.com', {}))).getResponse()).toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('limits codes per install per hour, across emails', async () => {
    const { otp } = build({ otpPerDevicePerHour: 2 });
    await otp.send('sign_in', 'a1@example.com', { installId: 'dev-1' });
    await otp.send('sign_in', 'a2@example.com', { installId: 'dev-1' });
    expect((await errorOf(otp.send('sign_in', 'a3@example.com', { installId: 'dev-1' }))).getResponse()).toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('limits codes per IP per hour, across emails', async () => {
    const { otp } = build({ otpPerIpPerHour: 2 });
    await otp.send('sign_in', 'b1@example.com', { ip: '10.0.0.1' });
    await otp.send('sign_in', 'b2@example.com', { ip: '10.0.0.1' });
    expect((await errorOf(otp.send('sign_in', 'b3@example.com', { ip: '10.0.0.1' }))).getResponse()).toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('keeps sign-in and deletion codes apart', async () => {
    const { otp, codeOf } = build();
    await otp.send('sign_in', 'ann@example.com', {});
    const signIn = codeOf();
    await otp.send('delete_account', 'ann@example.com', {});
    const deletion = codeOf();
    const probe = signIn === deletion ? '999999' : signIn;
    expect((await errorOf(otp.verify('delete_account', 'ann@example.com', probe))).getResponse()).toMatchObject({
      code: 'OTP_INVALID',
    });
  });
});
