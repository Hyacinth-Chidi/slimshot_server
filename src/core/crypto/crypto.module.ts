import { Global, Module } from '@nestjs/common';

import { EnvelopeCryptoService, MASTER_KEY } from './envelope-crypto.service';

@Global()
@Module({
  providers: [
    {
      provide: MASTER_KEY,
      useFactory: (): string => {
        const key = process.env.MASTER_ENCRYPTION_KEY;
        if (!key) {
          throw new Error(
            'MASTER_ENCRYPTION_KEY is not set. It cannot live in the database — ' +
              'it is the key that decrypts the database-stored secrets.',
          );
        }
        return key;
      },
    },
    EnvelopeCryptoService,
  ],
  exports: [EnvelopeCryptoService],
})
export class CryptoModule {}
