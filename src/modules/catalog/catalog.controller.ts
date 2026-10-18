import {
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Ip,
  Param,
  Post,
  Query,
} from '@nestjs/common';

import { IdentityHashService } from '../../core/identity/identity-hash.service';
import { RateLimiter } from '../../core/rate-limit/rate-limiter';
import { CATALOG_LIMITS, type CatalogLimits } from './catalog-limits';
import { CatalogService } from './catalog.service';
import { CatalogAssetsQueryDto, CatalogCategoriesQueryDto } from './dto/catalog-query.dto';

/** The app's sound library. Public: no sign-in, limited per IP. Contract: docs/app-catalog-api.md. */
@Controller('api/app/v1/catalog')
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly limiter: RateLimiter,
    private readonly hashes: IdentityHashService,
    @Inject(CATALOG_LIMITS) private readonly limits: CatalogLimits,
  ) {}

  @Get('categories')
  async categories(@Query() q: CatalogCategoriesQueryDto, @Ip() ip: string) {
    await this.limit('read', ip, this.limits.readPerMinute);
    return { success: true as const, data: await this.catalog.categories(q.kind, q.root) };
  }

  @Get('assets')
  async assets(@Query() q: CatalogAssetsQueryDto, @Ip() ip: string) {
    await this.limit('read', ip, this.limits.readPerMinute);
    const { items, nextCursor } = await this.catalog.assets(q);
    return { success: true as const, data: items, meta: { nextCursor } };
  }

  @Post('assets/:id/download')
  @HttpCode(200)
  async download(@Param('id') id: string, @Ip() ip: string) {
    await this.limit('download', ip, this.limits.downloadPerMinute);
    return { success: true as const, data: await this.catalog.download(id) };
  }

  /** Per IP. Fails open: a Redis outage must not take the public catalogue down. */
  private async limit(bucket: 'read' | 'download', ip: string | undefined, perMinute: number): Promise<void> {
    try {
      await this.limiter.hit(`catalog:${bucket}:${this.hashes.hash('ip', ip ?? 'unknown')}`, perMinute, 60);
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === HttpStatus.TOO_MANY_REQUESTS) throw error;
    }
  }
}
