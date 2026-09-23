import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { createHash, randomBytes } from 'node:crypto';

import { REDIS } from '../../core/cache/cache.service';

/**
 * Matches the dashboard's 2-minute idle lock, so the server-side window and the
 * UI lock expire together rather than one outliving the other.
 */
const GRANT_TTL_SECONDS = 120;

/**
 * A short-lived, single-use, key-scoped authorisation to write one secret
 * setting. Issued by a successful password re-authentication.
 *
 * The alternative is holding the password in browser memory for the whole edit,
 * which the dashboard spec forbids. A token that expires in two minutes and can
 * only write one key is strictly less dangerous than a lingering password.
 *
 * Deliberately NOT a JWT: nothing about a grant should be self-describing or
 * verifiable offline. It is an opaque random string whose only meaning is a row
 * in Redis that can be deleted.
 */
@Injectable()
export class ElevationService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async issue(adminId: string, key: string): Promise<string> {
    const grant = randomBytes(32).toString('base64url');
    await this.redis.set(
      this.redisKey(grant),
      JSON.stringify({ adminId, key }),
      'EX',
      GRANT_TTL_SECONDS,
    );
    return grant;
  }

  /** Validates and destroys the grant. Returns false for any mismatch. */
  async consume(grant: string, adminId: string, key: string): Promise<boolean> {
    const redisKey = this.redisKey(grant);
    const raw = await this.redis.get(redisKey);
    if (!raw) return false;

    const parsed = JSON.parse(raw) as { adminId: string; key: string };
    if (parsed.adminId !== adminId || parsed.key !== key) return false;

    await this.redis.del(redisKey);
    return true;
  }

  /** Called on logout and on deactivation: expiry is the backstop, not the only control. */
  async revokeForAdmin(adminId: string): Promise<void> {
    const keys = await this.redis.keys('elevation:*');
    for (const k of keys) {
      const raw = await this.redis.get(k);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as { adminId: string };
      if (parsed.adminId === adminId) await this.redis.del(k);
    }
  }

  /** The grant is stored by hash, so a Redis dump does not yield usable grants. */
  private redisKey(grant: string): string {
    return `elevation:${createHash('sha256').update(grant).digest('hex')}`;
  }
}
