import { HttpStatus, Injectable } from '@nestjs/common';

import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { isUniqueViolation } from '../../core/errors/prisma-errors';
import type { Prisma } from '../../generated/prisma/client';
import { CreditTxType } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedAppUser } from '../accounts/user-auth.guard';
import { CreditSettingsService } from '../credits/credit-settings.service';
import { LedgerService } from '../credits/ledger.service';

/** A claim opens again this long after the last one. */
export const DAILY_INTERVAL_MS = 24 * 3_600_000;

export interface DailyRewardStatus {
  enabled: boolean;
  credits: number;
  /** When the next claim opens; null when one can be claimed now (or it is switched off). */
  nextClaimAt: string | null;
}

export interface DailyRewardClaim {
  credits: number;
  balance: number;
  nextClaimAt: string;
}

type Db = Pick<Prisma.TransactionClient, 'creditTransaction'>;

const after = (at: Date) => new Date(at.getTime() + DAILY_INTERVAL_MS);

/**
 * Daily credits: a signed-in user claims the amount the owner set, once every
 * 24 hours from their last claim. Each claim is keyed to the one before it, so
 * however many arrive together, the ledger pays one.
 */
@Injectable()
export class DailyRewardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: CreditSettingsService,
    private readonly ledger: LedgerService,
  ) {}

  async status(userId: string, now = new Date()): Promise<DailyRewardStatus> {
    const [s, last] = await Promise.all([this.settings.get(), this.lastClaim(this.prisma, userId)]);
    const next = last ? after(last.createdAt) : null;
    return {
      enabled: s.dailyRewardEnabled,
      credits: s.dailyRewardCredits,
      nextClaimAt: s.dailyRewardEnabled && next && now < next ? next.toISOString() : null,
    };
  }

  async claim(user: AuthenticatedAppUser, now = new Date()): Promise<DailyRewardClaim> {
    const s = await this.settings.get();
    if (!s.dailyRewardEnabled) {
      throw appError(HttpStatus.CONFLICT, ErrorCode.DAILY_REWARD_OFF, 'Daily credits are switched off.');
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        // One claim at a time per user: a second waits here, then sees the first.
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${user.id} FOR UPDATE`;
        const last = await this.lastClaim(tx, user.id);
        if (last && now < after(last.createdAt)) throw notReady(after(last.createdAt));
        const { transaction } = await this.ledger.post(
          {
            userId: user.id,
            type: CreditTxType.daily_reward,
            amount: s.dailyRewardCredits,
            reference: last ? `after:${last.id}` : `first:${user.id}`,
            requireActive: true,
          },
          tx,
        );
        return {
          credits: transaction.amount,
          balance: transaction.balanceAfter,
          nextClaimAt: after(transaction.createdAt).toISOString(),
        };
      });
    } catch (err) {
      // Another claim keyed to the same previous one committed first: that one paid.
      if (isUniqueViolation(err)) {
        const winner = await this.lastClaim(this.prisma, user.id);
        throw notReady(after(winner?.createdAt ?? now));
      }
      throw err;
    }
  }

  private lastClaim(db: Db, userId: string) {
    return db.creditTransaction.findFirst({
      where: { userId, type: CreditTxType.daily_reward },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true },
    });
  }
}

function notReady(nextClaimAt: Date) {
  return appError(HttpStatus.CONFLICT, ErrorCode.DAILY_REWARD_NOT_READY, 'Your daily credits are not ready yet.', {
    nextClaimAt: nextClaimAt.toISOString(),
  });
}
