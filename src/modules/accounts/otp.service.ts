import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { randomInt, timingSafeEqual } from 'node:crypto';

import { REDIS } from '../../core/cache/cache.service';
import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { IdentityHashService } from '../../core/identity/identity-hash.service';
import { RateLimiter } from '../../core/rate-limit/rate-limiter';
import { CreditSettingsService } from '../credits/credit-settings.service';
import { EMAIL_SENDER, type EmailSender } from './email-sender';

export type OtpPurpose = 'sign_in' | 'delete_account';
export const OTP_TTL_SECONDS = 600;
const HOUR = 3_600;

const MESSAGES: Record<OtpPurpose, { subject: string; text: (code: string) => string }> = {
  sign_in: {
    subject: 'Your SlimShot sign-in code',
    text: (code) =>
      `Your SlimShot code is ${code}. It expires in 10 minutes.\n\nIf you did not try to sign in, ignore this email.`,
  },
  delete_account: {
    subject: 'Confirm deleting your SlimShot account',
    text: (code) =>
      `Enter ${code} to confirm deleting your SlimShot account. It expires in 10 minutes.\n\nIf you did not ask for this, ignore this email; nothing will be deleted.`,
  },
};

/** 6-digit email codes. Redis holds only an HMAC of each code and an attempts counter. */
@Injectable()
export class OtpService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly hashes: IdentityHashService,
    private readonly settings: CreditSettingsService,
    private readonly limiter: RateLimiter,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
  ) {}

  async send(
    purpose: OtpPurpose,
    email: string,
    scope: { installId?: string; ip?: string },
  ): Promise<{ resendAfterSeconds: number; expiresInSeconds: number }> {
    const s = await this.settings.get();
    const who = this.hashes.hash('email', email);
    const cooldownKey = `otp:cooldown:${purpose}:${who}`;

    const wait = await this.redis.ttl(cooldownKey);
    if (wait > 0) {
      throw appError(HttpStatus.TOO_MANY_REQUESTS, ErrorCode.OTP_RESEND_TOO_SOON, 'Wait before asking for another code.', {
        retryAfterSeconds: wait,
      });
    }
    // The caller's own limits first: a refused caller must not use up the email's budget,
    // which would lock its owner out. Each purpose has its own email budget.
    if (scope.ip) await this.limiter.hit(`otp:ip:${this.hashes.hash('ip', scope.ip)}`, s.otpPerIpPerHour, HOUR);
    if (scope.installId) await this.limiter.hit(`otp:install:${scope.installId}`, s.otpPerDevicePerHour, HOUR);
    await this.limiter.hit(`otp:email:${purpose}:${who}`, s.otpPerEmailPerHour, HOUR);

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.redis.set(this.codeKey(purpose, who), this.codeHash(purpose, email, code), 'EX', OTP_TTL_SECONDS);
    await this.redis.set(this.attemptsKey(purpose, who), '0', 'EX', OTP_TTL_SECONDS);
    if (s.otpResendCooldownSeconds > 0) await this.redis.set(cooldownKey, '1', 'EX', s.otpResendCooldownSeconds);

    const message = MESSAGES[purpose];
    await this.email.send({ to: email, subject: message.subject, text: message.text(code) });
    return { resendAfterSeconds: s.otpResendCooldownSeconds, expiresInSeconds: OTP_TTL_SECONDS };
  }

  async verify(purpose: OtpPurpose, email: string, code: string): Promise<void> {
    const s = await this.settings.get();
    const who = this.hashes.hash('email', email);
    const codeKey = this.codeKey(purpose, who);
    const attemptsKey = this.attemptsKey(purpose, who);

    const stored = await this.redis.get(codeKey);
    if (!stored) {
      throw appError(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.OTP_EXPIRED, 'This code has expired. Request a new one.');
    }
    // Counted atomically before comparing, so parallel guesses cannot exceed the budget.
    const attempts = await this.redis.incr(attemptsKey);
    if (attempts <= s.otpMaxAttempts && this.matches(stored, this.codeHash(purpose, email, code))) {
      await this.redis.del(codeKey, attemptsKey);
      return;
    }
    if (attempts >= s.otpMaxAttempts) {
      await this.redis.del(codeKey, attemptsKey);
      throw appError(HttpStatus.TOO_MANY_REQUESTS, ErrorCode.OTP_ATTEMPTS_EXCEEDED, 'Too many wrong codes. Request a new one.');
    }
    throw appError(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.OTP_INVALID, 'That code is not right.', {
      attemptsLeft: s.otpMaxAttempts - attempts,
    });
  }

  private codeKey(purpose: OtpPurpose, who: string): string {
    return `otp:code:${purpose}:${who}`;
  }

  private attemptsKey(purpose: OtpPurpose, who: string): string {
    return `otp:attempts:${purpose}:${who}`;
  }

  private codeHash(purpose: OtpPurpose, email: string, code: string): string {
    return this.hashes.hash('otp', `${purpose}:${email}:${code}`);
  }

  private matches(a: string, b: string): boolean {
    return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }
}
