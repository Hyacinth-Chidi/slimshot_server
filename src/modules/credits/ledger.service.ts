import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { isUniqueViolation } from '../../core/errors/prisma-errors';
import type { CreditTransaction, Prisma } from '../../generated/prisma/client';
import { AccountStatus, CreditTxType } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';

export interface LedgerEntryInput {
  userId: string;
  type: CreditTxType;
  /** Signed, non-zero integer. */
  amount: number;
  /** What this entry is for (job id, AdMob transaction id, referral id, …). One entry per type+reference, ever. */
  reference: string;
  metadata?: Record<string, unknown>;
  /** Spending paths: a suspended account cannot. Grants leave this off. */
  requireActive?: boolean;
}

export interface LedgerResult {
  transaction: CreditTransaction;
  replayed: boolean;
}

/**
 * The only writer of CreditTransaction and User.creditBalance. One guarded
 * UPDATE moves the balance only if it stays >= 0, and the insert's unique
 * idempotency key makes every grant or charge happen at most once. Both run
 * in one transaction, so the cached balance always equals the ledger sum.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async post(input: LedgerEntryInput, tx?: Prisma.TransactionClient): Promise<LedgerResult> {
    if (!Number.isInteger(input.amount) || input.amount === 0) {
      throw new Error('Ledger amounts are non-zero integers.');
    }
    const key = `${input.type}:${input.reference}`;
    const db = tx ?? this.prisma;

    // Already applied: answer with it, even if the balance could not cover it now.
    const existing = await db.creditTransaction.findUnique({ where: { idempotencyKey: key } });
    if (existing) return { transaction: existing, replayed: true };

    if (tx) return { transaction: await this.apply(tx, input, key), replayed: false };

    try {
      return { transaction: await this.prisma.$transaction((t) => this.apply(t, input, key)), replayed: false };
    } catch (err) {
      if (isUniqueViolation(err)) {
        // A concurrent request with the same key committed first.
        const winner = await this.prisma.creditTransaction.findUnique({ where: { idempotencyKey: key } });
        if (winner) return { transaction: winner, replayed: true };
      }
      throw err;
    }
  }

  private async apply(tx: Prisma.TransactionClient, input: LedgerEntryInput, key: string): Promise<CreditTransaction> {
    const { userId, amount } = input;
    const updated = await tx.user.updateMany({
      where: {
        id: userId,
        accountStatus: input.requireActive ? AccountStatus.active : { not: AccountStatus.deleted },
        ...(amount < 0 ? { creditBalance: { gte: -amount } } : {}),
      },
      data: { creditBalance: { increment: amount } },
    });
    if (updated.count === 0) throw await this.refusal(tx, input);

    // The UPDATE holds the row lock until commit, so this reads our own result.
    const { creditBalance } = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { creditBalance: true },
    });
    return tx.creditTransaction.create({
      data: {
        userId,
        type: input.type,
        amount,
        balanceAfter: creditBalance,
        idempotencyKey: key,
        reference: input.reference,
        ...(input.metadata ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
      },
    });
  }

  private async refusal(
    tx: Prisma.TransactionClient,
    { userId, amount, requireActive }: LedgerEntryInput,
  ): Promise<HttpException> {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { accountStatus: true, creditBalance: true },
    });
    if (!user || user.accountStatus === AccountStatus.deleted) {
      return appError(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'This account no longer exists.');
    }
    // Only spending paths are closed by suspension; an admin debit is refused on the balance alone.
    if (requireActive && user.accountStatus === AccountStatus.suspended) {
      return appError(HttpStatus.FORBIDDEN, ErrorCode.ACCOUNT_SUSPENDED, 'This account is suspended. Contact support.');
    }
    return appError(HttpStatus.PAYMENT_REQUIRED, ErrorCode.INSUFFICIENT_CREDITS, 'Not enough credits.', {
      required: -amount,
      balance: user.creditBalance,
    });
  }
}
