import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';

import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { AccountStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { UserTokensService } from './user-tokens.service';

export interface AuthenticatedAppUser {
  id: string;
  sessionId: string;
  deviceId: string;
  status: AccountStatus;
}

/**
 * App routes that need an account. No bearer, or a bearer that is not a JWT
 * (such as the old anonymous device token), means "sign in"; a bad or ended
 * session means "refresh or sign in again". Suspended users pass; paths that
 * spend check status themselves.
 */
@Injectable()
export class UserAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: UserTokensService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined>; appUser?: AuthenticatedAppUser }>();

    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token || token.split('.').length !== 3) {
      throw appError(HttpStatus.UNAUTHORIZED, ErrorCode.SIGN_IN_REQUIRED, 'Sign in to use this feature.');
    }

    const claims = await this.tokens.verifyAccess(token);
    const session = await this.prisma.userSession.findUnique({
      where: { id: claims.sid },
      select: { id: true, revokedAt: true, deviceId: true, user: { select: { id: true, accountStatus: true } } },
    });
    if (
      !session ||
      session.revokedAt ||
      session.user.id !== claims.sub ||
      session.user.accountStatus === AccountStatus.deleted
    ) {
      throw appError(HttpStatus.UNAUTHORIZED, ErrorCode.UNAUTHENTICATED, 'This session has ended. Sign in again.');
    }

    req.appUser = {
      id: session.user.id,
      sessionId: session.id,
      deviceId: session.deviceId,
      status: session.user.accountStatus,
    };
    return true;
  }
}
