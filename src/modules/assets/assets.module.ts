import { Module } from '@nestjs/common';

import { AUDIO_DESCRIPTOR } from './kinds/audio/audio.descriptor';
import { ASSET_KIND_DESCRIPTOR } from './asset-kind.interface';
import { AssetService } from './asset.service';
import { KindRegistry } from './kind-registry';

@Module({
  providers: [
    KindRegistry,
    { provide: ASSET_KIND_DESCRIPTOR, useValue: [AUDIO_DESCRIPTOR] },
    AssetService,
  ],
  exports: [KindRegistry, AssetService],
})
export class AssetsModule {}
