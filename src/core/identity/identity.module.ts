import { Global, Module } from '@nestjs/common';

import { RateLimiter } from '../rate-limit/rate-limiter';
import { IdentityHashService } from './identity-hash.service';

@Global()
@Module({ providers: [IdentityHashService, RateLimiter], exports: [IdentityHashService, RateLimiter] })
export class IdentityModule {}
