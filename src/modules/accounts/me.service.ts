import { Injectable } from '@nestjs/common';

import { AccountStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { adsUsedToday } from '../credits/ad-allowance';
import { CreditSettingsService } from '../credits/credit-settings.service';

export interface MeView {
  id: string;
  email: string | null;
  username: string | null;
  referralCode: string | null;
  creditBalance: number;
  accountStatus: AccountStatus;
  needsClaim: boolean;
  signInMethods: { google: boolean; email: boolean };
  ads: { rewardCredits: number; dailyCap: number; remainingToday: number };
}

@Injectable()
export class MeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: CreditSettingsService,
  ) {}

  async view(userId: string, now = new Date()): Promise<MeView> {
    const [user, settings, adsToday] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          username: true,
          referralCode: true,
          creditBalance: true,
          accountStatus: true,
          claimedAt: true,
          googleSub: true,
        },
      }),
      this.settings.get(),
      adsUsedToday(this.prisma, userId, now),
    ]);
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      referralCode: user.referralCode,
      creditBalance: user.creditBalance,
      accountStatus: user.accountStatus,
      needsClaim: user.claimedAt === null,
      signInMethods: { google: user.googleSub !== null, email: user.email !== null },
      ads: {
        rewardCredits: settings.adRewardCredits,
        dailyCap: settings.adDailyCap,
        remainingToday: Math.max(0, settings.adDailyCap - adsToday),
      },
    };
  }
}
