import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import type Redis from 'ioredis';
import { createHash, randomBytes } from 'node:crypto';

import { AdminRole } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { REDIS } from '../../core/cache/cache.service';
import { SettingsService } from '../../core/settings/settings.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
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
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.bootstrap();
  }

  async login(dto: LoginDto, ctx: TokenContext): Promise<TokenPair> {
    await this.assertNotLockedOut(dto.email);

    const admin = await this.prisma.adminUser.findFirst({
      where: { email: dto.email, deletedAt: null },
    });

    const ok =
      admin !== null &&
      admin.isActive &&
      (await this.passwords.verify(admin.passwordHash, dto.password));

    if (!ok) {
      await this.recordFailure(dto.email, ctx);
      // Identical message for unknown-email and wrong-password so the endpoint
      // cannot be used to enumerate which accounts exist.
      throw new UnauthorizedException('Invalid email or password.');
    }

    await this.redis.del(this.attemptKey(dto.email));
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
    if (row) await this.tokens.revokeFamily(row.familyId);
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
   * Runs once at boot. Generates the JWT signing secret if absent, and creates
   * the first owner from env if no admin exists. Self-disabling.
   */
  async bootstrap(): Promise<void> {
    // Must NOT use get() here: it throws for an unset minLength setting, so the
    // read meant to detect "no secret yet" could not survive a fresh database.
    const hasSecret = await this.settings.isConfigured('auth.jwtAccessSecret');
    if (!hasSecret) {
      await this.settings.set(
        'auth.jwtAccessSecret',
        randomBytes(48).toString('base64url'),
        'system',
      );
      this.logger.log('Generated auth.jwtAccessSecret on first boot.');
    }

    const adminCount = await this.prisma.adminUser.count({
      where: { deletedAt: null },
    });
    if (adminCount > 0) return;

    const email = process.env.ADMIN_BOOTSTRAP_EMAIL;
    const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;

    if (!email || !password) {
      this.logger.warn(
        'No admin accounts exist. Set ADMIN_BOOTSTRAP_EMAIL and ' +
          'ADMIN_BOOTSTRAP_PASSWORD, then restart, to create the first owner.',
      );
      return;
    }

    await this.prisma.adminUser.create({
      data: {
        email: email.trim().toLowerCase(),
        name: 'Owner',
        role: AdminRole.owner,
        passwordHash: await this.passwords.hash(password),
      },
    });

    await this.settings.set('auth.bootstrapCompleted', true, 'system');
    this.logger.log(`Bootstrapped first owner account: ${email}`);
  }

  private attemptKey(email: string): string {
    return `auth:login:fail:${email.toLowerCase()}`;
  }

  private async assertNotLockedOut(email: string): Promise<void> {
    const max = await this.settings.get<number>('auth.loginMaxAttempts');
    const current = Number((await this.redis.get(this.attemptKey(email))) ?? '0');

    if (current >= max) {
      throw new UnauthorizedException(
        'Too many failed login attempts. Try again later.',
      );
    }
  }

  private async recordFailure(email: string, ctx: TokenContext): Promise<void> {
    const key = this.attemptKey(email);
    const lockout = await this.settings.get<number>('auth.loginLockoutSeconds');

    await this.redis.incr(key);
    await this.redis.expire(key, lockout);

    await this.audit.record({
      actorType: 'system',
      action: 'auth.login.failed',
      entityType: 'AdminUser',
      after: { email },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }
}

function hashFor(token: string): string {
  // Mirrors TokenService.hashToken — both hash the presented token before lookup.
  return createHash('sha256').update(token).digest('hex');
}
