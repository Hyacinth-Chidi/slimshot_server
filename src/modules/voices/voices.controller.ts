import { Controller, Get, HttpException, HttpStatus, Inject, Ip } from '@nestjs/common';

import { IdentityHashService } from '../../core/identity/identity-hash.service';
import { RateLimiter } from '../../core/rate-limit/rate-limiter';
import { CATALOG_LIMITS, type CatalogLimits } from '../catalog/catalog-limits';
import { VoicesService } from './voices.service';

/**
 * The voices the app offers for text to speech, each with a free sample.
 * Public, like the catalogue, and limited per IP at its read rate. Contract:
 * docs/app-api/text-to-speech.md.
 */
@Controller('api/app/v1/voices')
export class VoicesController {
  constructor(
    private readonly voices: VoicesService,
    private readonly limiter: RateLimiter,
    private readonly hashes: IdentityHashService,
    @Inject(CATALOG_LIMITS) private readonly limits: CatalogLimits,
  ) {}

  @Get()
  async list(@Ip() ip: string) {
    await this.limit(ip);
    return { success: true as const, data: await this.voices.listForApp() };
  }

  /** Per IP. Fails open, as the catalogue does: a Redis outage must not take the list down. */
  private async limit(ip: string | undefined): Promise<void> {
    try {
      await this.limiter.hit(`voices:read:${this.hashes.hash('ip', ip ?? 'unknown')}`, this.limits.readPerMinute, 60);
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === HttpStatus.TOO_MANY_REQUESTS) throw error;
    }
  }
}
