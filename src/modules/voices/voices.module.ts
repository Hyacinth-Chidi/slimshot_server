import { Module } from '@nestjs/common';

import { ProvidersModule } from '../providers/providers.module';
import { VoicesService } from './voices.service';

@Module({
  imports: [ProvidersModule],
  providers: [VoicesService],
  exports: [VoicesService],
})
export class VoicesModule {}
