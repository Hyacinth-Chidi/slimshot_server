import { Global, Module } from '@nestjs/common';

import { CryptoModule } from '../crypto/crypto.module';
import { SettingsService } from './settings.service';

@Global()
@Module({
  imports: [CryptoModule],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
