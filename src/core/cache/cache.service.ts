import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { createHash } from 'node:crypto';

export const REDIS = Symbol('REDIS');

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async wrap<T>(
    namespace: string,
    keyParts: unknown,
    factory: () => Promise<T>,
    ttlSeconds: number,
  ): Promise<T> {
    let key: string;
    try {
      key = await this.buildKey(namespace, keyParts);
      const hit = await this.redis.get(key);
      if (hit) return JSON.parse(hit) as T;
    } catch (error) {
      // A cache outage must degrade to a slow response, never to an error.
      // buildKey() itself reads the generation counter from redis, so a
      // read failure there must be caught here too, not just the final get.
      this.logger.warn(`cache read failed for ${namespace}: ${String(error)}`);
      return factory();
    }

    const value = await factory();

    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (error) {
      this.logger.warn(`cache write failed for ${key}: ${String(error)}`);
    }

    return value;
  }

  /**
   * O(1) invalidation. Every key in the namespace embeds the generation, so
   * incrementing it orphans all of them without scanning or tracking keys.
   *
   * Returns false if the bump could not be applied. A cache outage must not fail
   * the operation that triggered invalidation (e.g. publishing an asset), but a
   * failed bump means stale entries keep being served until their TTL expires —
   * so it is logged at error level rather than swallowed quietly.
   */
  async bumpGeneration(namespace: string): Promise<boolean> {
    try {
      await this.redis.incr(this.generationKey(namespace));
      return true;
    } catch (error) {
      this.logger.error(
        `cache invalidation FAILED for namespace "${namespace}" — stale entries ` +
          `will be served until their TTL expires: ${String(error)}`,
      );
      return false;
    }
  }

  async del(namespace: string, keyParts: unknown): Promise<boolean> {
    try {
      await this.redis.del(await this.buildKey(namespace, keyParts));
      return true;
    } catch (error) {
      this.logger.error(
        `cache eviction FAILED for namespace "${namespace}": ${String(error)}`,
      );
      return false;
    }
  }

  private async buildKey(namespace: string, keyParts: unknown): Promise<string> {
    const generation = (await this.redis.get(this.generationKey(namespace))) ?? '0';
    const digest = createHash('sha1')
      .update(stableStringify(keyParts))
      .digest('hex')
      .slice(0, 16);
    return `cache:${namespace}:g${generation}:${digest}`;
  }

  /**
   * The generation key has no TTL deliberately: it must outlive the entries it
   * shadows. Residual risk — if Redis evicts this key independently under memory
   * pressure while older-generation entries survive, the namespace collapses back
   * to g0 and those stale entries become reachable again until their own TTL
   * expires. Bounded by ttlSeconds, not instant.
   */
  private generationKey(namespace: string): string {
    return `cache:gen:${namespace}`;
  }
}

/** Property order must not change the cache key. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);

  return `{${entries.join(',')}}`;
}
