import { Module } from '@nestjs/common';

import { FontsService } from './fonts.service';

@Module({
  providers: [FontsService],
  exports: [FontsService],
})
export class FontsModule {}
