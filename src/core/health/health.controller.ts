import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import type Redis from 'ioredis';

import { PrismaService } from '../../prisma/prisma.service';
import { REDIS } from '../cache/cache.service';
import { StorageRegistry } from '../storage/storage.registry';

type CheckState = 'up' | 'down';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly storage: StorageRegistry,
  ) {}

  /** Liveness: is the process running? Must not touch dependencies. */
  @Get()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: can this instance actually serve traffic? */
  @Get('ready')
  async ready(): Promise<{ status: 'ok'; checks: Record<string, CheckState> }> {
    const checks: Record<string, CheckState> = {
      database: await probe(() => this.prisma.$queryRaw`SELECT 1`),
      redis: await probe(() => this.redis.ping()),
      storage: await probe(() => this.storage.getDefault()),
    };

    if (Object.values(checks).some((state) => state === 'down')) {
      throw new ServiceUnavailableException({ status: 'error', checks });
    }

    return { status: 'ok', checks };
  }
}

async function probe(fn: () => Promise<unknown>): Promise<CheckState> {
  try {
    await fn();
    return 'up';
  } catch {
    return 'down';
  }
}
