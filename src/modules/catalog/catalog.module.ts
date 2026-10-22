import { Module } from '@nestjs/common';

import { RateLimiter } from '../../core/rate-limit/rate-limiter';
import { CATALOG_LIMITS, DEFAULT_CATALOG_LIMITS } from './catalog-limits';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { FontCatalogService } from './font-catalog.service';

@Module({
  controllers: [CatalogController],
  providers: [
    CatalogService,
    FontCatalogService,
    RateLimiter,
    { provide: CATALOG_LIMITS, useValue: DEFAULT_CATALOG_LIMITS },
  ],
})
export class CatalogModule {}
