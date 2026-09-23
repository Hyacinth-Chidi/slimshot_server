import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../../modules/auth/token.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: unknown }>();

    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');

    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException('Missing bearer token.');
    }

    const claims = await this.tokens.verifyAccessToken(token);

    // A signature check alone would let a deactivated or deleted admin keep full
    // authority until their access token expired — up to the whole 15-minute TTL,
    // with no way to cut it short. Revoking refresh tokens does not help, because
    // the access token never touches them. One indexed primary-key lookup per
    // request buys immediate revocation.
    const admin = await this.prisma.adminUser.findFirst({
      where: { id: claims.sub, deletedAt: null },
      select: { id: true, isActive: true, role: true },
    });

    if (!admin || !admin.isActive) {
      throw new UnauthorizedException('Account is no longer active.');
    }

    // Trust the row over the token for role: a demotion must take effect at once
    // rather than persisting until the token the admin already holds expires.
    req.user = { ...claims, role: admin.role };
    return true;
  }
}
