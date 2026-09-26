import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type Redis from 'ioredis';

import { authConfig, type AuthConfig } from '../../config';
import { AuditService } from '../../core/audit/audit.service';
import { REDIS } from '../../core/cache/cache.service';

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
 * Login-failure budget: counts failed logins per email and locks the email out
 * for a configured window (AUTH_LOGIN_MAX_ATTEMPTS / AUTH_LOGIN_LOCKOUT_SECONDS).
 */
@Injectable()
export class LoginAttemptService {
  constructor(
    @Inject(authConfig.KEY) private readonly config: AuthConfig,
    private readonly audit: AuditService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async assertNotLockedOut(email: string): Promise<void> {
    const max = this.config.login.maxAttempts;
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

    await this.redis.incr(key);
    await this.redis.expire(key, this.config.login.lockoutSeconds);

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
    // One counter per email, shared by every login attempt.
    return `auth:login:fail:${email.toLowerCase()}`;
  }
}
