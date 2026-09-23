import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { createHash, randomBytes } from 'node:crypto';

import { REDIS } from '../cache/cache.service';

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
    const redisKey = this.redisKey(grant);
    const indexKey = this.indexKey(adminId);

    // The index is written in the same round trip as the grant, so a grant is
    // never briefly live-but-unindexed. EXPIRE is re-applied on every issue:
    // the set must always outlive its newest member, or it dies while a grant
    // is still valid and revokeForAdmin silently misses it.
    await this.redis
      .pipeline()
      .set(redisKey, JSON.stringify({ adminId, key }), 'EX', GRANT_TTL_SECONDS)
      .sadd(indexKey, redisKey)
      .expire(indexKey, GRANT_TTL_SECONDS)
      .exec();

    return grant;
  }

  /** Validates and destroys the grant. Returns false for any mismatch. */
  async consume(grant: string, adminId: string, key: string): Promise<boolean> {
    const redisKey = this.redisKey(grant);
    const raw = await this.redis.get(redisKey);
    if (!raw) return false;

    const parsed = this.parseGrant(raw);
    if (!parsed) return false;
    if (parsed.adminId !== adminId || parsed.key !== key) return false;

    // Drop the index entry too, so a busy admin's set does not fill with the
    // hashes of grants that were spent rather than expired.
    await this.redis
      .pipeline()
      .del(redisKey)
      .srem(this.indexKey(adminId), redisKey)
      .exec();
    return true;
  }

  /**
   * Called on logout and on deactivation: expiry is the backstop, not the only
   * control.
   *
   * Reads the admin's own index rather than scanning. KEYS walks the ENTIRE
   * keyspace and blocks Redis's single thread while it does, and this now runs
   * on every logout for every role, against a keyspace that grows without bound
   * (failed BullMQ jobs are retained by design). The number of live grants is
   * small; the keyspace around them is not, and the grant TTL does not bound it.
   */
  async revokeForAdmin(adminId: string): Promise<void> {
    const indexKey = this.indexKey(adminId);
    const redisKeys = await this.redis.smembers(indexKey);

    // No set: expired, evicted, or never created. Nothing to revoke and
    // nothing to clean up.
    if (redisKeys.length === 0) return;

    // A member whose grant key already expired is deleted as a no-op -- DEL
    // reports it as 0 removed and does not error -- so a stale id costs
    // nothing and can never resurrect a grant. One variadic DEL, not one
    // round trip per member.
    await this.redis.del(...redisKeys, indexKey);
  }

  /** The per-admin index of live grant keys, so revocation never scans. */
  private indexKey(adminId: string): string {
    return `elevation:admin:${adminId}`;
  }

  /** The grant is stored by hash, so a Redis dump does not yield usable grants. */
  private redisKey(grant: string): string {
    return `elevation:${createHash('sha256').update(grant).digest('hex')}`;
  }

  /**
   * Redis content is untrusted input: a corrupt or foreign value under an
   * elevation:* key must deny access, not throw. A credential check that 500s
   * tells an attacker something a uniform refusal would not.
   */
  private parseGrant(raw: string): { adminId: string; key: string } | null {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as { adminId?: unknown }).adminId === 'string' &&
        typeof (parsed as { key?: unknown }).key === 'string'
      ) {
        return parsed as { adminId: string; key: string };
      }
      return null;
    } catch {
      return null;
    }
  }
}
