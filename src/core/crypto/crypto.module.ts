import { Module } from '@nestjs/common';

import { cryptoConfig, type CryptoConfig } from '../../config';
import { EnvelopeCryptoService, MASTER_KEY } from './envelope-crypto.service';

@Module({
  providers: [
    {
      provide: MASTER_KEY,
      inject: [cryptoConfig.KEY],
      useFactory: (crypto: CryptoConfig): string => crypto.masterKey,
    },
    EnvelopeCryptoService,
  ],
  exports: [EnvelopeCryptoService],
})
export class CryptoModule {}
