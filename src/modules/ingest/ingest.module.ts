import { Module } from '@nestjs/common';

import { AssetsModule } from '../assets/assets.module';
import { IngestService } from './ingest.service';

@Module({
  imports: [AssetsModule],
  providers: [IngestService],
  exports: [IngestService],
})
export class IngestModule {}
