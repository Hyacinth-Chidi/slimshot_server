import { Module } from '@nestjs/common';

import { RateLimiter } from '../../core/rate-limit/rate-limiter';
import { CATALOG_LIMITS, DEFAULT_CATALOG_LIMITS } from '../catalog/catalog-limits';
import { ProvidersModule } from '../providers/providers.module';
import { VoicesController } from './voices.controller';
import { VoicesService } from './voices.service';

@Module({
  imports: [ProvidersModule],
  controllers: [VoicesController],
  providers: [VoicesService, RateLimiter, { provide: CATALOG_LIMITS, useValue: DEFAULT_CATALOG_LIMITS }],
  exports: [VoicesService],
})
export class VoicesModule {}
