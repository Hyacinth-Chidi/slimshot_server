import { Module } from '@nestjs/common';

import { AssetsModule } from '../assets/assets.module';
import { AuthModule } from '../auth/auth.module';
import { CreditSettingsModule } from '../credits/credit-settings.module';
import { CreditsModule } from '../credits/credits.module';
import { IngestModule } from '../ingest/ingest.module';
import { ProvidersModule } from '../providers/providers.module';
import { TaxonomyModule } from '../taxonomy/taxonomy.module';
import { AdminAssetsController } from './admin-assets.controller';
import { AdminAuditController } from './admin-audit.controller';
import { AdminCategoriesController } from './admin-categories.controller';
import { AdminCreditSettingsController } from './admin-credit-settings.controller';
import { AdminCreditsController } from './admin-credits.controller';
import { AdminJobsController } from './admin-jobs.controller';
import { AdminKindsController } from './admin-kinds.controller';
import { AdminPricingRulesController } from './admin-pricing-rules.controller';
import { AdminProvidersController } from './admin-providers.controller';
import { AdminStatsController } from './admin-stats.controller';
import { StatsService } from './stats.service';

@Module({
  imports: [
    AssetsModule,
    IngestModule,
    AuthModule,
    TaxonomyModule,
    ProvidersModule,
    CreditsModule,
    CreditSettingsModule,
  ],
  controllers: [
    AdminAssetsController,
    AdminKindsController,
    AdminCategoriesController,
    AdminStatsController,
    AdminAuditController,
    AdminJobsController,
    AdminProvidersController,
    AdminCreditSettingsController,
    AdminPricingRulesController,
    AdminCreditsController,
  ],
  providers: [StatsService],
})
export class AdminModule {}
