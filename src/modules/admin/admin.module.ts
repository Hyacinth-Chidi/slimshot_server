import { Module } from '@nestjs/common';

import { AssetsModule } from '../assets/assets.module';
import { AuthModule } from '../auth/auth.module';
import { IngestModule } from '../ingest/ingest.module';
import { AdminAssetsController } from './admin-assets.controller';
import { AdminKindsController } from './admin-kinds.controller';

@Module({
  imports: [AssetsModule, IngestModule, AuthModule],
  controllers: [AdminAssetsController, AdminKindsController],
})
export class AdminModule {}
