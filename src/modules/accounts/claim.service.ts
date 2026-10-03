import { HttpStatus, Injectable } from '@nestjs/common';

import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { isUniqueViolation } from '../../core/errors/prisma-errors';
import { canonicalEmail } from '../../core/identity/email';
import { IdentityHashService } from '../../core/identity/identity-hash.service';
import type { CreditSettings, Prisma } from '../../generated/prisma/client';
import { AccountStatus, BonusClaimKind, CreditTxType, ReferralOutcome } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { CreditSettingsService } from '../credits/credit-settings.service';
import { LedgerService } from '../credits/ledger.service';
import type { ClaimDto } from './dto/me.dto';
import { MeService, type MeView } from './me.service';
import { normalizeReferralCode } from './referral-code';
import type { AuthenticatedAppUser } from './user-auth.guard';
import { UsernameService } from './username.service';

export type BonusReason = 'BONUS_ALREADY_CLAIMED' | 'IP_LIMIT_REACHED';

export interface ClaimResult {
  user: MeView;
  bonus: { granted: boolean; credits: number; reason?: BonusReason };
  referral: { outcome: ReferralOutcome; credits: number } | null;
}

interface Eligibility {
  eligible: boolean;
  reason?: BonusReason;
}

interface ClaimKeys {
  email: string | null;
  install: string;
}

const DAY_MS = 86_400_000;
const alreadyClaimed = () =>
  appError(HttpStatus.CONFLICT, ErrorCode.ALREADY_CLAIMED, 'This account is already set up.');

/**
 * The first-run step: username, signup bonus and referral, in one transaction.
 * The bonus is once per verified email and once per install, remembered as
 * HMACs that outlive the account.
 */
@Injectable()
export class ClaimService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usernames: UsernameService,
    private readonly me: MeService,
    private readonly settings: CreditSettingsService,
    private readonly hashes: IdentityHashService,
    private readonly ledger: LedgerService,
  ) {}

  async claim(appUser: AuthenticatedAppUser, dto: ClaimDto): Promise<ClaimResult> {
    if (appUser.status === AccountStatus.suspended) {
      throw appError(HttpStatus.FORBIDDEN, ErrorCode.ACCOUNT_SUSPENDED, 'This account is suspended. Contact support.');
    }
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: appUser.id },
      select: { claimedAt: true, email: true, signupIpLimited: true },
    });
    if (user.claimedAt) throw alreadyClaimed();

    const username = await this.usernames.assertAvailable(dto.username, appUser.id);
    const inviterId = dto.referralCode ? await this.findInviter(dto.referralCode, appUser.id) : null;
    const settings = await this.settings.get();
    const keys: ClaimKeys = {
      email: user.email ? this.hashes.hash('bonus-email', canonicalEmail(user.email)) : null,
      install: this.hashes.hash('bonus-install', appUser.deviceId),
    };
    const eligibility = await this.eligibility(user.signupIpLimited, keys);

    let outcome: Omit<ClaimResult, 'user'>;
    try {
      outcome = await this.apply(appUser.id, username, inviterId, settings, keys, eligibility);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const owner = await this.prisma.user.findUnique({ where: { username }, select: { id: true } });
      if (owner && owner.id !== appUser.id) {
        throw appError(HttpStatus.CONFLICT, ErrorCode.USERNAME_TAKEN, 'That username is taken.');
      }
      // A parallel claim from the same email or install took the bonus first.
      outcome = await this.apply(appUser.id, username, inviterId, settings, keys, {
        eligible: false,
        reason: 'BONUS_ALREADY_CLAIMED',
      });
    }
    return { user: await this.me.view(appUser.id), ...outcome };
  }

  private async eligibility(ipLimited: boolean, keys: ClaimKeys): Promise<Eligibility> {
    if (ipLimited) return { eligible: false, reason: 'IP_LIMIT_REACHED' };
    const seen = await this.prisma.bonusClaim.findFirst({
      where: {
        OR: [
          { kind: BonusClaimKind.install, hmac: keys.install },
          ...(keys.email ? [{ kind: BonusClaimKind.email, hmac: keys.email }] : []),
        ],
      },
      select: { id: true },
    });
    return seen ? { eligible: false, reason: 'BONUS_ALREADY_CLAIMED' } : { eligible: true };
  }

  private apply(
    userId: string,
    username: string,
    inviterId: string | null,
    s: CreditSettings,
    keys: ClaimKeys,
    eligibility: Eligibility,
  ): Promise<Omit<ClaimResult, 'user'>> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.user.updateMany({
        where: { id: userId, claimedAt: null },
        data: { username, claimedAt: new Date() },
      });
      if (claimed.count === 0) throw alreadyClaimed();

      let bonusCredits = 0;
      if (eligibility.eligible) {
        // Unique (kind, hmac): a parallel claim from the same email or install fails here.
        if (keys.email) await tx.bonusClaim.create({ data: { kind: BonusClaimKind.email, hmac: keys.email } });
        await tx.bonusClaim.create({ data: { kind: BonusClaimKind.install, hmac: keys.install } });
        if (s.signupBonusCredits > 0) {
          await this.ledger.post(
            { userId, type: CreditTxType.signup_bonus, amount: s.signupBonusCredits, reference: userId },
            tx,
          );
          bonusCredits = s.signupBonusCredits;
        }
      }

      const referral = inviterId ? await this.applyReferral(tx, inviterId, userId, eligibility.eligible, s) : null;
      return {
        bonus: {
          granted: eligibility.eligible,
          credits: bonusCredits,
          ...(eligibility.reason ? { reason: eligibility.reason } : {}),
        },
        referral,
      };
    });
  }

  private async applyReferral(
    tx: Prisma.TransactionClient,
    inviterId: string,
    inviteeId: string,
    inviteeEligible: boolean,
    s: CreditSettings,
  ): Promise<{ outcome: ReferralOutcome; credits: number }> {
    let outcome: ReferralOutcome = ReferralOutcome.invitee_ineligible;
    if (inviteeEligible) {
      // One inviter's referrals in single file, so the cap holds under concurrency.
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${inviterId} FOR UPDATE`;
      const since = new Date(Date.now() - s.referralCapDays * DAY_MS);
      const rewarded = await tx.referral.count({
        where: { inviterId, outcome: ReferralOutcome.rewarded, createdAt: { gte: since } },
      });
      outcome = rewarded >= s.referralCapCount ? ReferralOutcome.inviter_capped : ReferralOutcome.rewarded;
    }

    const row = await tx.referral.create({ data: { inviterId, inviteeId, outcome }, select: { id: true } });
    let credits = 0;
    if (outcome !== ReferralOutcome.invitee_ineligible && s.referralInviteeCredits > 0) {
      await this.ledger.post(
        { userId: inviteeId, type: CreditTxType.referral_invitee, amount: s.referralInviteeCredits, reference: row.id },
        tx,
      );
      credits = s.referralInviteeCredits;
    }
    if (outcome === ReferralOutcome.rewarded && s.referralInviterCredits > 0) {
      await this.ledger.post(
        { userId: inviterId, type: CreditTxType.referral_inviter, amount: s.referralInviterCredits, reference: row.id },
        tx,
      );
    }
    return { outcome, credits };
  }

  private async findInviter(raw: string, selfId: string): Promise<string> {
    const code = normalizeReferralCode(raw);
    const inviter = code
      ? await this.prisma.user.findUnique({ where: { referralCode: code }, select: { id: true, accountStatus: true } })
      : null;
    if (!inviter || inviter.id === selfId || inviter.accountStatus !== AccountStatus.active) {
      throw appError(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.REFERRAL_CODE_INVALID, 'That referral code is not valid.');
    }
    return inviter.id;
  }
}
