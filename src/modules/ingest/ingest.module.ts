import { Module } from '@nestjs/common';

import { AssetsModule } from '../assets/assets.module';
import { FontsModule } from '../fonts/fonts.module';
import { IngestService } from './ingest.service';

@Module({
  imports: [AssetsModule, FontsModule],
  providers: [IngestService],
  exports: [IngestService],
})
export class IngestModule {}
