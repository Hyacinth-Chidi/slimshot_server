import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { cryptoConfig } from '../../config';
import { CryptoModule } from './crypto.module';
import { EnvelopeCryptoService } from './envelope-crypto.service';

describe('CryptoModule', () => {
  it('builds the service from the crypto namespace', async () => {
    const moduleRef = await Test.createTestingModule({
      // isGlobal, as in AppModule: CryptoModule injects the namespace without importing ConfigModule.
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [cryptoConfig] }), CryptoModule],
    }).compile();

    const svc = moduleRef.get(EnvelopeCryptoService);
    expect(svc.decrypt(svc.encrypt('round trip'))).toBe('round trip');
  });
});
