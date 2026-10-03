import { HttpStatus, Injectable } from '@nestjs/common';

import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { isUniqueViolation } from '../../core/errors/prisma-errors';
import { AccountStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import type { ClaimDto } from './dto/me.dto';
import { MeService, type MeView } from './me.service';
import type { AuthenticatedAppUser } from './user-auth.guard';
import { UsernameService } from './username.service';

export interface ClaimResult {
  user: MeView;
  bonus: null;
  referral: null;
}

const alreadyClaimed = () =>
  appError(HttpStatus.CONFLICT, ErrorCode.ALREADY_CLAIMED, 'This account is already set up.');

@Injectable()
export class ClaimService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usernames: UsernameService,
    private readonly me: MeService,
  ) {}

  async claim(appUser: AuthenticatedAppUser, dto: ClaimDto): Promise<ClaimResult> {
    if (appUser.status === AccountStatus.suspended) {
      throw appError(HttpStatus.FORBIDDEN, ErrorCode.ACCOUNT_SUSPENDED, 'This account is suspended. Contact support.');
    }
    const { claimedAt } = await this.prisma.user.findUniqueOrThrow({
      where: { id: appUser.id },
      select: { claimedAt: true },
    });
    if (claimedAt) throw alreadyClaimed();

    const username = await this.usernames.assertAvailable(dto.username, appUser.id);
    let done: { count: number };
    try {
      done = await this.prisma.user.updateMany({
        where: { id: appUser.id, claimedAt: null },
        data: { username, claimedAt: new Date() },
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw appError(HttpStatus.CONFLICT, ErrorCode.USERNAME_TAKEN, 'That username is taken.');
      throw err;
    }
    if (done.count === 0) throw alreadyClaimed();
    return { user: await this.me.view(appUser.id), bonus: null, referral: null };
  }
}
