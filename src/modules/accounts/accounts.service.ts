import { HttpStatus, Injectable } from '@nestjs/common';

import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { isUniqueViolation } from '../../core/errors/prisma-errors';
import { normalizeEmail } from '../../core/identity/email';
import { IdentityHashService } from '../../core/identity/identity-hash.service';
import { RateLimiter } from '../../core/rate-limit/rate-limiter';
import { PrismaService } from '../../prisma/prisma.service';
import { CreditSettingsService } from '../credits/credit-settings.service';
import { DevicesService } from '../devices/devices.service';
import { isDisposable } from './email-domain';
import { GoogleVerifier } from './google-verifier';
import { MeService, type MeView } from './me.service';
import { OtpService } from './otp.service';
import { newReferralCode } from './referral-code';
import { type AppTokenPair, UserTokensService } from './user-tokens.service';

export interface SignInResponse extends AppTokenPair {
  isNewAccount: boolean;
  needsClaim: boolean;
  user: MeView;
}

const ACCOUNT = { id: true, googleSub: true, claimedAt: true } as const;
type AccountRow = { id: string; googleSub: string | null; claimedAt: Date | null };
const DAY = 86_400;

@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly devices: DevicesService,
    private readonly tokens: UserTokensService,
    private readonly otp: OtpService,
    private readonly google: GoogleVerifier,
    private readonly settings: CreditSettingsService,
    private readonly limiter: RateLimiter,
    private readonly hashes: IdentityHashService,
    private readonly me: MeService,
  ) {}

  async startEmail(rawEmail: string, deviceToken: string, ip?: string) {
    const email = normalizeEmail(rawEmail);
    const deviceId = await this.requireDevice(deviceToken);
    await this.assertAllowedDomain(email);
    const sent = await this.otp.send('sign_in', email, { installId: deviceId, ip });
    return { sentTo: email, ...sent };
  }

  async verifyEmail(rawEmail: string, code: string, deviceToken: string, ip?: string): Promise<SignInResponse> {
    const email = normalizeEmail(rawEmail);
    const deviceId = await this.requireDevice(deviceToken);
    await this.otp.verify('sign_in', email, code);
    const existing = await this.prisma.user.findUnique({ where: { email }, select: ACCOUNT });
    const { user, isNew } = existing ? { user: existing, isNew: false } : await this.create({ email }, ip);
    return this.finish(user, isNew, deviceId);
  }

  async signInWithGoogle(idToken: string, deviceToken: string, ip?: string): Promise<SignInResponse> {
    const deviceId = await this.requireDevice(deviceToken);
    const { sub, email } = await this.google.verify(idToken);
    await this.assertAllowedDomain(email);

    const bySub = await this.prisma.user.findUnique({ where: { googleSub: sub }, select: ACCOUNT });
    if (bySub) return this.finish(bySub, false, deviceId);

    const byEmail = await this.prisma.user.findUnique({ where: { email }, select: ACCOUNT });
    if (byEmail) {
      if (byEmail.googleSub && byEmail.googleSub !== sub) {
        throw appError(HttpStatus.CONFLICT, ErrorCode.ACCOUNT_LINK_CONFLICT, 'This email is linked to a different Google account.');
      }
      const linked = await this.prisma.user.update({ where: { id: byEmail.id }, data: { googleSub: sub }, select: ACCOUNT });
      return this.finish(linked, false, deviceId);
    }

    const { user, isNew } = await this.create({ email, googleSub: sub }, ip);
    return this.finish(user, isNew, deviceId);
  }

  refresh(refreshToken: string): Promise<AppTokenPair> {
    return this.tokens.rotate(refreshToken);
  }

  logout(refreshToken: string): Promise<void> {
    return this.tokens.logout(refreshToken);
  }

  private async create(
    data: { email: string; googleSub?: string },
    ip?: string,
  ): Promise<{ user: AccountRow; isNew: boolean }> {
    const settings = await this.settings.get();
    const fromThisIp = ip ? await this.limiter.increment(`signup:ip:${this.hashes.hash('ip', ip)}`, DAY) : 0;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const user = await this.prisma.user.create({
          data: { ...data, referralCode: newReferralCode(), signupIpLimited: fromThisIp > settings.ipSignupLimitPer24h },
          select: ACCOUNT,
        });
        return { user, isNew: true };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Either a parallel sign-in just created this account, or the referral code collided.
        const existing = await this.prisma.user.findUnique({ where: { email: data.email }, select: ACCOUNT });
        if (existing) return { user: existing, isNew: false };
      }
    }
    throw new Error('Could not allocate a unique referral code.');
  }

  private async finish(user: AccountRow, isNew: boolean, deviceId: string): Promise<SignInResponse> {
    await this.prisma.device.update({ where: { id: deviceId }, data: { userId: user.id } });
    const pair = await this.tokens.startSession(user.id, deviceId);
    return { ...pair, isNewAccount: isNew, needsClaim: user.claimedAt === null, user: await this.me.view(user.id) };
  }

  private async requireDevice(deviceToken: string): Promise<string> {
    const device = deviceToken ? await this.devices.authenticate(deviceToken) : null;
    if (!device) {
      throw appError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        ErrorCode.DEVICE_NOT_REGISTERED,
        'Register this install first (POST /devices), then sign in.',
      );
    }
    return device.id;
  }

  private async assertAllowedDomain(email: string): Promise<void> {
    const { disposableEmailDomains } = await this.settings.get();
    if (isDisposable(email, disposableEmailDomains)) {
      throw appError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        ErrorCode.EMAIL_DOMAIN_NOT_ALLOWED,
        'Disposable email addresses cannot be used. Use your regular email.',
      );
    }
  }
}
