import { Module } from '@nestjs/common';

import { AUDIO_DESCRIPTOR } from './kinds/audio/audio.descriptor';
import { ASSET_KIND_DESCRIPTOR } from './asset-kind.interface';
import { KindRegistry } from './kind-registry';

@Module({
  providers: [
    KindRegistry,
    { provide: ASSET_KIND_DESCRIPTOR, useValue: [AUDIO_DESCRIPTOR] },
  ],
  exports: [KindRegistry],
})
export class AssetsModule {}
