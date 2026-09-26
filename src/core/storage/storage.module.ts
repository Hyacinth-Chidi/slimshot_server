import { Global, Module } from '@nestjs/common';

import { StorageRegistry } from './storage.registry';

@Global()
@Module({
  providers: [StorageRegistry],
  exports: [StorageRegistry],
})
export class StorageModule {}
