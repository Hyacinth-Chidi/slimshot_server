import { randomUUID } from 'node:crypto';

import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

import { AuditService } from '../../core/audit/audit.service';
import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { AccountStatus, CreditTxType } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { AccountDeletionService } from '../accounts/account-deletion.service';
import { startOfUtcDay } from '../credits/ad-allowance';
import { CreditsService, type HistoryItem } from '../credits/credits.service';
import { LedgerService } from '../credits/ledger.service';

export interface UserSummary {
  id: string;
  email: string | null;
  username: string | null;
  accountStatus: AccountStatus;
  creditBalance: number;
  createdAt: Date;
  claimedAt: Date | null;
}

export interface UserDetail extends UserSummary {
  referralCode: string | null;
  deletedAt: Date | null;
  signInMethods: { google: boolean; email: boolean };
}

export interface CreditStatsRow {
  day: string;
  type: CreditTxType;
  granted: number;
  spent: number;
}

const SUMMARY = {
  id: true,
  email: true,
  username: true,
  accountStatus: true,
  creditBalance: true,
  createdAt: true,
  claimedAt: true,
} as const;

const DAY_MS = 86_400_000;

/** What the dashboard does to app users: find, inspect, adjust, suspend, delete. */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly credits: CreditsService,
    private readonly deletion: AccountDeletionService,
    private readonly audit: AuditService,
  ) {}

  async search(q?: string, cursor?: string, limit = 20): Promise<{ items: UserSummary[]; nextCursor: string | null }> {
    const term = q?.trim().toLowerCase();
    const rows = await this.prisma.user.findMany({
      where: term
        ? {
            OR: [
              { email: { contains: term, mode: 'insensitive' } },
              { username: { contains: term, mode: 'insensitive' } },
            ],
          }
        : {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: SUMMARY,
    });
    const items = rows.slice(0, limit);
    return { items, nextCursor: rows.length > limit ? items[items.length - 1].id : null };
  }

  async detail(id: string): Promise<UserDetail> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { ...SUMMARY, referralCode: true, deletedAt: true, googleSub: true },
    });
    if (!user) throw this.notFound();
    const { googleSub, ...rest } = user;
    return { ...rest, signInMethods: { google: googleSub !== null, email: user.email !== null } };
  }

  ledgerOf(id: string, cursor?: string, limit?: number): Promise<{ items: HistoryItem[]; nextCursor: string | null }> {
    return this.credits.history(id, cursor, limit);
  }

  async adjust(id: string, amount: number, reason: string, adminId: string): Promise<{ balance: number }> {
    let balance: number;
    try {
      const { transaction } = await this.ledger.post({
        userId: id,
        type: CreditTxType.admin_adjustment,
        amount,
        reference: randomUUID(),
        metadata: { reason, adminId },
      });
      balance = transaction.balanceAfter;
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === HttpStatus.PAYMENT_REQUIRED) {
        const details = (error.getResponse() as { details?: { balance?: number } }).details;
        throw appError(
          HttpStatus.UNPROCESSABLE_ENTITY,
          ErrorCode.VALIDATION_FAILED,
          'This would take the balance below zero.',
          { balance: details?.balance },
        );
      }
      throw error;
    }
    await this.audit.record({
      actorId: adminId,
      actorType: 'admin',
      action: 'credits.adjusted',
      entityType: 'User',
      entityId: id,
      after: { amount, reason },
    });
    return { balance };
  }

  async suspend(id: string, reason: string, adminId: string): Promise<UserDetail> {
    await this.moveStatus(id, AccountStatus.active, AccountStatus.suspended);
    await this.audit.record({
      actorId: adminId,
      actorType: 'admin',
      action: 'user.suspended',
      entityType: 'User',
      entityId: id,
      after: { reason },
    });
    return this.detail(id);
  }

  async unsuspend(id: string, adminId: string): Promise<UserDetail> {
    await this.moveStatus(id, AccountStatus.suspended, AccountStatus.active);
    await this.audit.record({
      actorId: adminId,
      actorType: 'admin',
      action: 'user.unsuspended',
      entityType: 'User',
      entityId: id,
    });
    return this.detail(id);
  }

  remove(id: string, reason: string, adminId: string): Promise<void> {
    return this.deletion.deleteAccount(id, { type: 'admin', id: adminId, reason });
  }

  /** Credits granted (positive entries) and spent (negative, reported positive) per UTC day and type. */
  async creditStats(days: number, now = new Date()): Promise<CreditStatsRow[]> {
    const since = new Date(startOfUtcDay(now).getTime() - (days - 1) * DAY_MS);
    // "createdAt" is a timestamp without time zone holding UTC, so to_char gives the UTC day.
    const rows = await this.prisma.$queryRaw<
      Array<{ day: string; type: CreditTxType; granted: bigint | number; spent: bigint | number }>
    >`
      SELECT to_char("createdAt", 'YYYY-MM-DD') AS "day", "type",
        COALESCE(SUM("amount") FILTER (WHERE "amount" > 0), 0) AS "granted",
        COALESCE(-SUM("amount") FILTER (WHERE "amount" < 0), 0) AS "spent"
      FROM "CreditTransaction"
      WHERE "createdAt" >= ${since}
      GROUP BY 1, 2
      ORDER BY 1, 2`;
    return rows.map((r) => ({ day: r.day, type: r.type, granted: Number(r.granted), spent: Number(r.spent) }));
  }

  /** One guarded UPDATE, so two admins clicking at once cannot both "succeed". */
  private async moveStatus(id: string, from: AccountStatus, to: AccountStatus): Promise<void> {
    const { count } = await this.prisma.user.updateMany({
      where: { id, accountStatus: from },
      data: { accountStatus: to },
    });
    if (count > 0) return;
    const user = await this.prisma.user.findUnique({ where: { id }, select: { accountStatus: true } });
    if (!user) throw this.notFound();
    throw appError(HttpStatus.CONFLICT, ErrorCode.CONFLICT, `This account is ${user.accountStatus}, not ${from}.`);
  }

  private notFound() {
    return appError(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'User not found.');
  }
}
