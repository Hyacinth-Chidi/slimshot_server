import { BadRequestException, HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { randomBytes } from 'node:crypto';

import { admobConfig, type AdmobConfig } from '../../config';
import { REDIS } from '../../core/cache/cache.service';
import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { AccountStatus, CreditTxType } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedAppUser } from '../accounts/user-auth.guard';
import { adsUsedToday, nextUtcMidnight } from '../credits/ad-allowance';
import { CreditSettingsService } from '../credits/credit-settings.service';
import { LedgerService } from '../credits/ledger.service';
import { AdmobVerifier, type SsvCallback, SsvSignatureError } from './admob-verifier';

export type AdSessionStatus = 'pending' | 'granted' | 'capped' | 'rejected';

interface StoredSession {
  userId: string;
  status: AdSessionStatus;
  credits?: number;
}

const SESSION_TTL_SECONDS = 3_600;
const sessionKey = (nonce: string) => `ad:session:${nonce}`;
/** AdMob's callback names the ad unit by number; the console shows `ca-app-pub-…/<number>`. Accept both. */
const adUnitNumber = (id: string) => id.trim().split('/').pop() ?? '';

/**
 * Rewarded ads. The app only learns the outcome: credits are granted when
 * AdMob's signed callback reaches the server, never on the app's word.
 */
@Injectable()
export class AdSessionsService {
  private readonly logger = new Logger(AdSessionsService.name);

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly settings: CreditSettingsService,
    private readonly verifier: AdmobVerifier,
    @Inject(admobConfig.KEY) private readonly cfg: AdmobConfig,
  ) {}

  async start(user: AuthenticatedAppUser) {
    if (user.status === AccountStatus.suspended) {
      throw appError(HttpStatus.FORBIDDEN, ErrorCode.ACCOUNT_SUSPENDED, 'This account is suspended. Contact support.');
    }
    const s = await this.settings.get();
    const now = new Date();
    const remaining = Math.max(0, s.adDailyCap - (await adsUsedToday(this.prisma, user.id, now)));
    if (remaining === 0) {
      throw appError(HttpStatus.CONFLICT, ErrorCode.AD_DAILY_CAP_REACHED, "You have watched today's rewarded ads. Come back tomorrow.", {
        resetsAt: nextUtcMidnight(now).toISOString(),
      });
    }
    const nonce = randomBytes(18).toString('base64url');
    await this.write(nonce, { userId: user.id, status: 'pending' });
    return { nonce, ssvUserId: user.id, rewardCredits: s.adRewardCredits, adsRemainingToday: remaining };
  }

  async status(user: AuthenticatedAppUser, nonce: string) {
    const session = await this.read(nonce);
    if (!session || session.userId !== user.id) {
      throw appError(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'No ad session with this id.');
    }
    const { creditBalance } = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { creditBalance: true },
    });
    return {
      status: session.status,
      ...(session.credits !== undefined ? { credits: session.credits } : {}),
      balance: creditBalance,
    };
  }

  /**
   * AdMob's server-side verification callback. Throws only for a bad signature
   * (400) or our own outage (500, so AdMob retries); every other case is
   * answered 200 so AdMob stops retrying.
   */
  async handleCallback(rawQuery: string): Promise<void> {
    let cb: SsvCallback;
    try {
      cb = await this.verifier.verify(rawQuery);
    } catch (err) {
      if (err instanceof SsvSignatureError) throw new BadRequestException(err.message);
      throw err;
    }

    const unit = adUnitNumber(cb.adUnit);
    if (this.cfg.adUnitIds.length > 0 && !this.cfg.adUnitIds.some((id) => adUnitNumber(id) === unit)) {
      this.logger.warn(`Ignored an AdMob callback for ad unit ${cb.adUnit}, which is not one of ours.`);
      return;
    }
    // The AdMob console's test callback carries no custom data: nothing to grant.
    const session = cb.customData ? await this.read(cb.customData) : null;
    if (!session) {
      this.logger.warn(`AdMob callback ${cb.transactionId} has no live ad session; nothing granted.`);
      return;
    }
    if (session.userId !== cb.userId) {
      await this.write(cb.customData, { ...session, status: 'rejected' });
      return;
    }

    const outcome = await this.grant(cb);
    await this.write(cb.customData, { ...session, ...outcome });
  }

  private async grant(cb: SsvCallback): Promise<Pick<StoredSession, 'status' | 'credits'>> {
    const s = await this.settings.get();
    try {
      return await this.prisma.$transaction(async (tx) => {
        // One user's rewards in single file, so the daily cap holds under concurrent callbacks.
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${cb.userId} FOR UPDATE`;
        const replay = await tx.creditTransaction.findUnique({
          where: { idempotencyKey: `${CreditTxType.rewarded_ad}:${cb.transactionId}` },
        });
        if (replay) return { status: 'granted' as const, credits: replay.amount };
        if ((await adsUsedToday(tx, cb.userId)) >= s.adDailyCap) return { status: 'capped' as const };
        if (s.adRewardCredits > 0) {
          await this.ledger.post(
            {
              userId: cb.userId,
              type: CreditTxType.rewarded_ad,
              amount: s.adRewardCredits,
              reference: cb.transactionId,
              requireActive: true,
              metadata: { adUnit: cb.adUnit, nonce: cb.customData },
            },
            tx,
          );
        }
        return { status: 'granted' as const, credits: s.adRewardCredits };
      });
    } catch (err) {
      // Suspended or deleted since the ad started: no reward, and nothing for AdMob to retry.
      if (err instanceof HttpException && [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND].includes(err.getStatus())) {
        return { status: 'rejected' };
      }
      throw err;
    }
  }

  private async read(nonce: string): Promise<StoredSession | null> {
    const raw = await this.redis.get(sessionKey(nonce));
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  }

  private async write(nonce: string, session: StoredSession): Promise<void> {
    await this.redis.set(sessionKey(nonce), JSON.stringify(session), 'EX', SESSION_TTL_SECONDS);
  }
}
