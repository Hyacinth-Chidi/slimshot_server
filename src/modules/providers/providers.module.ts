import { Module } from '@nestjs/common';

import { CryptoModule } from '../../core/crypto/crypto.module';
import { DeepgramProvider } from './deepgram.provider';
import { ElevenLabsProvider } from './elevenlabs.provider';
import { ProviderCredentialsService } from './provider-credentials.service';
import { ProviderRegistry } from './provider.registry';

// Static on purpose: admin endpoints and the caption worker must share one
// ProviderCredentialsService, so a key change clears the cache the worker reads.
@Module({
  imports: [CryptoModule],
  providers: [DeepgramProvider, ElevenLabsProvider, ProviderRegistry, ProviderCredentialsService],
  exports: [ProviderCredentialsService],
})
export class ProvidersModule {}
