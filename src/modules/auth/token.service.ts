import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { AdminRole } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { ElevationService } from '../../core/auth/elevation.service';
import { SettingsService } from '../../core/settings/settings.service';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AccessTokenClaims {
  sub: string;
  email: string;
  role: AdminRole;
}

export interface TokenContext {
  ip?: string;
  userAgent?: string;
}

interface AdminLike {
  id: string;
  email: string;
  role: AdminRole;
}

@Injectable()
export class TokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly jwt: JwtService,
    private readonly elevation: ElevationService,
  ) {}

  async issuePair(
    admin: AdminLike,
    context: TokenContext,
    familyId: string = randomUUID(),
  ): Promise<TokenPair> {
    const accessTtl = await this.settings.get<number>('auth.accessTokenTtlSeconds');
    const refreshTtl = await this.settings.get<number>('auth.refreshTokenTtlSeconds');
    const secret = await this.signingSecret();

    const accessToken = await this.jwt.signAsync(
      { sub: admin.id, email: admin.email, role: admin.role },
      { secret, expiresIn: accessTtl },
    );

    const refreshToken = randomBytes(48).toString('base64url');

    await this.prisma.refreshToken.create({
      data: {
        tokenHash: hashToken(refreshToken),
        familyId,
        adminUserId: admin.id,
        expiresAt: new Date(Date.now() + refreshTtl * 1000),
        ip: context.ip ?? null,
        userAgent: context.userAgent ?? null,
      },
    });

    return { accessToken, refreshToken, expiresIn: accessTtl };
  }

  async rotate(presented: string, context: TokenContext): Promise<TokenPair> {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(presented) },
      include: { admin: true },
    });

    if (!row) throw new UnauthorizedException('Invalid refresh token.');

    // Reuse of an already-revoked token means the token was stolen. Kill the
    // whole lineage so neither party keeps a working session.
    if (row.revokedAt) {
      await this.revokeFamily(row.familyId);
      throw new UnauthorizedException('Refresh token reuse detected.');
    }

    if (row.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Refresh token expired.');
    }

    await this.prisma.refreshToken.update({
      where: { tokenHash: row.tokenHash },
      data: { revokedAt: new Date() },
    });

    const admin = (row as { admin?: AdminLike }).admin;
    if (!admin) {
      // Unreachable while `admin` is a required relation. If it ever fires, the row is
      // orphaned — refuse rather than minting a token with invented claims, which would
      // grant whatever role we guessed to a principal we cannot identify.
      throw new UnauthorizedException('Refresh token is not linked to a valid account.');
    }

    const account = admin as AdminLike & { isActive?: boolean; deletedAt?: Date | null };
    if (account.isActive === false || account.deletedAt) {
      await this.revokeFamily(row.familyId);
      // Spec 6.7: any change to isActive/deletedAt revokes the admin's grants.
      // This is the one place the server observes a deactivation, so grant
      // revocation stays beside the refresh-token revocation rather than
      // drifting apart from it.
      await this.elevation.revokeForAdmin(admin.id);
      throw new UnauthorizedException('Account is no longer active.');
    }

    return this.issuePair(admin, context, row.familyId);
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    try {
      return await this.jwt.verifyAsync<AccessTokenClaims>(token, {
        secret: await this.signingSecret(),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired access token.');
    }
  }

  private async signingSecret(): Promise<string> {
    const secret = await this.settings.get<string>('auth.jwtAccessSecret');
    if (!secret) {
      throw new Error(
        'auth.jwtAccessSecret is empty. It is generated on first boot by the ' +
          'admin bootstrap; see Task 14.',
      );
    }
    return secret;
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
