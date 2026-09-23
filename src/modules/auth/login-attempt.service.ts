import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type Redis from 'ioredis';

import { AuditService } from '../../core/audit/audit.service';
import { REDIS } from '../../core/cache/cache.service';
import { SettingsService } from '../../core/settings/settings.service';

interface RequestContext {
  ip?: string;
  userAgent?: string;
}

interface FailureAudit {
  action: string;
  entityType: string;
  entityId?: string;
}

/**
 * Shared login-failure budget, extracted out of AuthService so any other path
 * that re-checks a password (e.g. the settings reveal/update step-up) spends
 * against the SAME counter as a failed login rather than getting its own.
 */
@Injectable()
export class LoginAttemptService {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async assertNotLockedOut(email: string): Promise<void> {
    const max = await this.settings.get<number>('auth.loginMaxAttempts');
    const current = Number((await this.redis.get(this.attemptKey(email))) ?? '0');

    if (current >= max) {
      throw new UnauthorizedException(
        'Too many failed login attempts. Try again later.',
      );
    }
  }

  async recordFailure(
    email: string,
    audit: FailureAudit,
    ctx: RequestContext,
  ): Promise<void> {
    const key = this.attemptKey(email);
    const lockout = await this.settings.get<number>('auth.loginLockoutSeconds');

    await this.redis.incr(key);
    await this.redis.expire(key, lockout);

    await this.audit.record({
      actorType: 'system',
      action: audit.action,
      entityType: audit.entityType,
      entityId: audit.entityId,
      after: { email },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }

  async clear(email: string): Promise<void> {
    await this.redis.del(this.attemptKey(email));
  }

  private attemptKey(email: string): string {
    // Deliberately the SAME key every caller that re-checks a password uses
    // (login, and the settings reveal/update step-up): a failed attempt on any
    // of those paths must count against one shared budget, or whichever path
    // does NOT share this key becomes an unthrottled password oracle.
    return `auth:login:fail:${email.toLowerCase()}`;
  }
}
