import { Module } from '@nestjs/common';

import { AssetsModule } from '../assets/assets.module';
import { AuthModule } from '../auth/auth.module';
import { IngestModule } from '../ingest/ingest.module';
import { AdminAssetsController } from './admin-assets.controller';
import { AdminKindsController } from './admin-kinds.controller';
import { AdminSettingsController } from './admin-settings.controller';
import { ElevationService } from './elevation.service';
import { SettingsAdminService } from './settings-admin.service';

@Module({
  imports: [AssetsModule, IngestModule, AuthModule],
  controllers: [AdminAssetsController, AdminKindsController, AdminSettingsController],
  providers: [ElevationService, SettingsAdminService],
})
export class AdminModule {}
