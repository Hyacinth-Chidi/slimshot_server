import { Global, Module } from '@nestjs/common';

import { CryptoModule } from '../crypto/crypto.module';
import { StorageRegistry } from './storage.registry';

@Global()
@Module({
  imports: [CryptoModule],
  providers: [StorageRegistry],
  exports: [StorageRegistry],
})
export class StorageModule {}
