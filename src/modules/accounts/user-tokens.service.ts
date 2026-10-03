import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';

import { appAuthConfig, type AppAuthConfig } from '../../config';
import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { AccountStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';

export const APP_TOKEN_AUDIENCE = 'slimshot-app';

export interface AppTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AppUserClaims {
  sub: string;
  sid: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function unauthenticated(message: string) {
  return appError(HttpStatus.UNAUTHORIZED, ErrorCode.UNAUTHENTICATED, message);
}

/** App-user tokens: their own secret and audience, never accepted by admin routes (or vice versa). */
@Injectable()
export class UserTokensService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(appAuthConfig.KEY) private readonly cfg: AppAuthConfig,
    private readonly jwt: JwtService,
  ) {}

  async startSession(userId: string, deviceId: string): Promise<AppTokenPair> {
    const session = await this.prisma.userSession.create({ data: { userId, deviceId }, select: { id: true } });
    return this.issue(userId, session.id);
  }

  async rotate(presented: string): Promise<AppTokenPair> {
    const row = await this.prisma.userRefreshToken.findUnique({
      where: { tokenHash: sha256(presented) },
      include: { session: { include: { user: { select: { accountStatus: true } } } } },
    });
    if (!row) throw unauthenticated('Invalid refresh token.');

    if (row.revokedAt || row.session.revokedAt) {
      // A rotated token came back: someone else holds a copy. End the whole session.
      await this.revokeSession(row.sessionId);
      throw unauthenticated('This session has ended. Sign in again.');
    }
    if (row.expiresAt.getTime() <= Date.now()) throw unauthenticated('Refresh token expired. Sign in again.');
    if (row.session.user.accountStatus === AccountStatus.deleted) {
      await this.revokeSession(row.sessionId);
      throw unauthenticated('This account no longer exists.');
    }

    // Claim the token atomically: of two simultaneous refreshes, only one rotates.
    const claimed = await this.prisma.userRefreshToken.updateMany({
      where: { id: row.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (claimed.count === 0) {
      await this.revokeSession(row.sessionId);
      throw unauthenticated('This session has ended. Sign in again.');
    }
    await this.prisma.userSession.update({ where: { id: row.sessionId }, data: { lastUsedAt: new Date() } });
    return this.issue(row.session.userId, row.sessionId);
  }

  async logout(presented: string): Promise<void> {
    const row = await this.prisma.userRefreshToken.findUnique({ where: { tokenHash: sha256(presented) } });
    if (row) await this.revokeSession(row.sessionId);
  }

  async revokeSession(sessionId: string): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.userSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: now } }),
      this.prisma.userRefreshToken.updateMany({ where: { sessionId, revokedAt: null }, data: { revokedAt: now } }),
    ]);
  }

  async verifyAccess(token: string): Promise<AppUserClaims> {
    try {
      return await this.jwt.verifyAsync<AppUserClaims>(token, {
        secret: this.cfg.jwtSecret,
        audience: APP_TOKEN_AUDIENCE,
      });
    } catch {
      throw unauthenticated('Invalid or expired access token.');
    }
  }

  private async issue(userId: string, sessionId: string): Promise<AppTokenPair> {
    const accessToken = await this.jwt.signAsync(
      { sub: userId, sid: sessionId },
      { secret: this.cfg.jwtSecret, expiresIn: this.cfg.accessTtlSeconds, audience: APP_TOKEN_AUDIENCE },
    );
    const refreshToken = randomBytes(48).toString('base64url');
    await this.prisma.userRefreshToken.create({
      data: {
        tokenHash: sha256(refreshToken),
        sessionId,
        expiresAt: new Date(Date.now() + this.cfg.refreshTtlSeconds * 1000),
      },
    });
    return { accessToken, refreshToken, expiresIn: this.cfg.accessTtlSeconds };
  }
}
