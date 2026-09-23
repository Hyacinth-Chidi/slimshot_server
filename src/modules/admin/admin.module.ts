import { Module } from '@nestjs/common';

import { AssetsModule } from '../assets/assets.module';
import { AuthModule } from '../auth/auth.module';
import { IngestModule } from '../ingest/ingest.module';
import { TaxonomyModule } from '../taxonomy/taxonomy.module';
import { AdminAssetsController } from './admin-assets.controller';
import { AdminAuditController } from './admin-audit.controller';
import { AdminCategoriesController } from './admin-categories.controller';
import { AdminJobsController } from './admin-jobs.controller';
import { AdminKindsController } from './admin-kinds.controller';
import { AdminSettingsController } from './admin-settings.controller';
import { AdminStatsController } from './admin-stats.controller';
import { ElevationService } from './elevation.service';
import { SettingsAdminService } from './settings-admin.service';
import { StatsService } from './stats.service';

@Module({
  imports: [AssetsModule, IngestModule, AuthModule, TaxonomyModule],
  controllers: [
    AdminAssetsController,
    AdminKindsController,
    AdminCategoriesController,
    AdminStatsController,
    AdminAuditController,
    AdminJobsController,
    AdminSettingsController,
  ],
  providers: [StatsService, ElevationService, SettingsAdminService],
})
export class AdminModule {}
