import { HttpStatus, Injectable, Logger } from '@nestjs/common';

import { AuditService } from '../../core/audit/audit.service';
import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { normalizeEmail } from '../../core/identity/email';
import { IdentityHashService } from '../../core/identity/identity-hash.service';
import { RateLimiter } from '../../core/rate-limit/rate-limiter';
import { AccountStatus, CreditTxType } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { LedgerService } from '../credits/ledger.service';
import { OtpService } from './otp.service';

export type DeletionActor = { type: 'user'; id: string } | { type: 'admin'; id: string; reason: string };

@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly otp: OtpService,
    private readonly audit: AuditService,
    private readonly limiter: RateLimiter,
    private readonly hashes: IdentityHashService,
  ) {}

  /**
   * Erases personal data and forfeits the balance, in one transaction. Ledger
   * and referral rows keep the now-anonymous user id; BonusClaim rows are kept
   * on purpose, so deleting and re-creating earns no second bonus.
   */
  async deleteAccount(userId: string, actor: DeletionActor): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { accountStatus: true, creditBalance: true },
      });
      if (!user || user.accountStatus === AccountStatus.deleted) {
        throw appError(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'This account no longer exists.');
      }
      if (user.creditBalance > 0) {
        await this.ledger.post(
          { userId, type: CreditTxType.account_deleted, amount: -user.creditBalance, reference: userId },
          tx,
        );
      }
      await tx.userRefreshToken.updateMany({ where: { session: { userId }, revokedAt: null }, data: { revokedAt: now } });
      await tx.userSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
      await tx.device.updateMany({ where: { userId }, data: { userId: null } });
      await tx.user.update({
        where: { id: userId },
        data: {
          email: null,
          googleSub: null,
          username: null,
          referralCode: null,
          phone: null,
          displayName: null,
          avatarUrl: null,
          accountStatus: AccountStatus.deleted,
          deletedAt: now,
        },
      });
    });
    await this.audit.record({
      actorId: actor.id,
      actorType: actor.type,
      action: 'user.deleted',
      entityType: 'User',
      entityId: userId,
      after: actor.type === 'admin' ? { reason: actor.reason } : { by: 'self' },
    });
  }

  /** Google Play's web deletion route. Same answer whether or not the account exists. */
  async requestWebDeletion(rawEmail: string, ip?: string): Promise<{ sentTo: string }> {
    const email = normalizeEmail(rawEmail);
    if (ip) await this.limiter.hit(`deletion:ip:${this.hashes.hash('ip', ip)}`, 20, 3_600);
    const user = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (user) {
      // A refusal (too soon, rate limited) or a mail failure must not change the answer,
      // or the page would reveal which emails have accounts.
      await this.otp.send('delete_account', email, { ip }).catch((err: unknown) => {
        this.logger.warn(`Web deletion code not sent: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    return { sentTo: email };
  }

  async confirmWebDeletion(rawEmail: string, code: string): Promise<void> {
    const email = normalizeEmail(rawEmail);
    await this.otp.verify('delete_account', email, code);
    const user = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (!user) {
      throw appError(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.OTP_EXPIRED, 'This code has expired. Request a new one.');
    }
    await this.deleteAccount(user.id, { type: 'user', id: user.id });
  }
}
