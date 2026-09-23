import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { SETTINGS } from '../../core/settings/setting-definitions';
import { SettingsService } from '../../core/settings/settings.service';
import { LoginAttemptService } from '../auth/login-attempt.service';
import { PasswordService } from '../auth/password.service';
import { ElevationService } from './elevation.service';

export interface RevealResult {
  value: string;
  grant: string;
  expiresIn: number;
}

export interface AuthProof {
  password?: string;
  grant?: string;
}

interface RequestContext {
  ip?: string;
  userAgent?: string;
}

const GRANT_TTL_SECONDS = 120;

@Injectable()
export class SettingsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly elevation: ElevationService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    private readonly attempts: LoginAttemptService,
  ) {}

  async reveal(
    key: string,
    adminId: string,
    password: string,
    ctx: RequestContext,
  ): Promise<RevealResult> {
    const admin = await this.loadAdmin(adminId);
    await this.attempts.assertNotLockedOut(admin.email);

    const ok = await this.passwords.verify(admin.passwordHash, password);
    if (!ok) {
      await this.attempts.recordFailure(
        admin.email,
        { action: 'settings.reveal.failed', entityType: 'SystemSetting', entityId: key },
        ctx,
      );
      throw new UnauthorizedException('Password is incorrect.');
    }

    await this.attempts.clear(admin.email);

    // Audit BEFORE returning, so a reveal that crashes mid-flight is still
    // recorded. The payload names the key, never the value.
    await this.audit.record({
      actorId: adminId,
      actorType: 'admin',
      action: 'settings.reveal.succeeded',
      entityType: 'SystemSetting',
      entityId: key,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    const value = await this.settings.revealSecret(key);
    const grant = await this.elevation.issue(adminId, key);

    return { value, grant, expiresIn: GRANT_TTL_SECONDS };
  }

  async update(
    key: string,
    value: unknown,
    adminId: string,
    proof: AuthProof,
    ctx: RequestContext,
  ): Promise<void> {
    const def = SETTINGS.get(key);
    if (!def) throw new ForbiddenException(`Unknown setting: ${key}`);

    if (def.secret) {
      await this.assertElevated(key, adminId, proof, ctx);
    }

    await this.settings.set(key, value, adminId);

    await this.audit.record({
      actorId: adminId,
      actorType: 'admin',
      action: 'settings.update',
      entityType: 'SystemSetting',
      entityId: key,
      // For a secret, record only that it changed — never the old or new value.
      after: def.secret ? { changed: true } : { value },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }

  private async assertElevated(
    key: string,
    adminId: string,
    proof: AuthProof,
    ctx: RequestContext,
  ): Promise<void> {
    if (proof.grant) {
      const ok = await this.elevation.consume(proof.grant, adminId, key);
      if (!ok) {
        throw new ForbiddenException(
          'That authorisation has expired or does not apply to this setting.',
        );
      }
      return;
    }

    if (proof.password) {
      const admin = await this.loadAdmin(adminId);
      await this.attempts.assertNotLockedOut(admin.email);
      const ok = await this.passwords.verify(admin.passwordHash, proof.password);
      if (!ok) {
        await this.attempts.recordFailure(
          admin.email,
          { action: 'settings.reveal.failed', entityType: 'SystemSetting', entityId: key },
          ctx,
        );
        throw new UnauthorizedException('Password is incorrect.');
      }
      await this.attempts.clear(admin.email);
      return;
    }

    throw new ForbiddenException(
      'Changing a secret setting requires your password or a current authorisation.',
    );
  }

  private async loadAdmin(adminId: string): Promise<{
    id: string;
    email: string;
    passwordHash: string;
  }> {
    const admin = await this.prisma.adminUser.findFirst({
      where: { id: adminId, deletedAt: null, isActive: true },
    });
    if (!admin) throw new UnauthorizedException('Account is no longer active.');
    return admin as unknown as { id: string; email: string; passwordHash: string };
  }
}
