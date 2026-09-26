import { Inject, Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { authConfig, type AuthConfig } from '../../config';
import { AdminRole } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { LoginAttemptService } from './login-attempt.service';
import { PasswordService } from './password.service';
import { TokenContext, TokenPair, TokenService } from './token.service';

export interface AdminProfile {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly attempts: LoginAttemptService,
    @Inject(authConfig.KEY) private readonly config: AuthConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.bootstrap();
  }

  async login(dto: LoginDto, ctx: TokenContext): Promise<TokenPair> {
    await this.attempts.assertNotLockedOut(dto.email);

    const admin = await this.prisma.adminUser.findFirst({
      where: { email: dto.email, deletedAt: null },
    });

    const ok =
      admin !== null &&
      admin.isActive &&
      (await this.passwords.verify(admin.passwordHash, dto.password));

    if (!ok) {
      await this.attempts.recordFailure(
        dto.email,
        { action: 'auth.login.failed', entityType: 'AdminUser' },
        ctx,
      );
      // Identical message for unknown-email and wrong-password so the endpoint
      // cannot be used to enumerate which accounts exist.
      throw new UnauthorizedException('Invalid email or password.');
    }

    await this.attempts.clear(dto.email);
    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });

    await this.audit.record({
      actorId: admin.id,
      actorType: 'admin',
      action: 'auth.login.succeeded',
      entityType: 'AdminUser',
      entityId: admin.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return this.tokens.issuePair(
      { id: admin.id, email: admin.email, role: admin.role },
      ctx,
    );
  }

  async refresh(dto: RefreshDto, ctx: TokenContext): Promise<TokenPair> {
    return this.tokens.rotate(dto.refreshToken, ctx);
  }

  async logout(refreshToken: string): Promise<void> {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashFor(refreshToken) },
    });
    if (!row) return;

    await this.tokens.revokeFamily(row.familyId);
  }

  async me(adminId: string): Promise<AdminProfile> {
    const admin = await this.prisma.adminUser.findFirst({
      where: { id: adminId, deletedAt: null },
    });
    if (!admin) throw new UnauthorizedException('Account no longer exists.');

    return {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      role: admin.role,
    };
  }

  /**
   * Runs once at boot. Creates the first owner from ADMIN_BOOTSTRAP_EMAIL /
   * ADMIN_BOOTSTRAP_PASSWORD if no admin exists yet. Self-disabling: once an
   * admin exists this does nothing, so the variables can be removed.
   */
  async bootstrap(): Promise<void> {
    const adminCount = await this.prisma.adminUser.count({ where: { deletedAt: null } });
    if (adminCount > 0) return;

    const credentials = this.config.bootstrap;
    if (!credentials) {
      this.logger.warn(
        'No admin accounts exist. Set ADMIN_BOOTSTRAP_EMAIL and ' +
          'ADMIN_BOOTSTRAP_PASSWORD, then restart, to create the first owner.',
      );
      return;
    }

    const email = credentials.email.trim().toLowerCase();
    await this.prisma.adminUser.create({
      data: {
        email,
        name: 'Owner',
        role: AdminRole.owner,
        passwordHash: await this.passwords.hash(credentials.password),
      },
    });
    this.logger.log(`Bootstrapped first owner account: ${email}`);
  }
}

function hashFor(token: string): string {
  // Mirrors TokenService.hashToken — both hash the presented token before lookup.
  return createHash('sha256').update(token).digest('hex');
}
