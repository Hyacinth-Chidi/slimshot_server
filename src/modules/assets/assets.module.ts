import { Module } from '@nestjs/common';

import { KIND_DESCRIPTORS } from './kinds';
import { ASSET_KIND_DESCRIPTOR } from './asset-kind.interface';
import { AssetService } from './asset.service';
import { KindRegistry } from './kind-registry';

@Module({
  providers: [
    KindRegistry,
    { provide: ASSET_KIND_DESCRIPTOR, useValue: KIND_DESCRIPTORS },
    AssetService,
  ],
  exports: [KindRegistry, AssetService],
})
export class AssetsModule {}
