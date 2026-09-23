import { Module } from '@nestjs/common';

import { ElevationService } from './elevation.service';

/**
 * ElevationService lives here rather than in AdminModule because both
 * AuthModule (logout and rotate must revoke grants, spec 6.7) and AdminModule
 * (issue and consume, spec 6.6) need it. AdminModule already imports
 * AuthModule, so leaving it in AdminModule would make AuthModule -> AdminModule
 * a cycle. A small shared module is the honest fix; forwardRef would only hide
 * the loop.
 */
@Module({
  providers: [ElevationService],
  exports: [ElevationService],
})
export class ElevationModule {}
