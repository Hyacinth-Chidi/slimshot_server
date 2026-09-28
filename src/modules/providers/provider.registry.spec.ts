import { ProviderKind } from '../../generated/prisma/enums';
import { DeepgramProvider } from './deepgram.provider';
import { ElevenLabsProvider } from './elevenlabs.provider';
import { ProviderRegistry } from './provider.registry';

describe('ProviderRegistry', () => {
  const cfg = { deepgramModel: 'nova-3', elevenlabsModel: 'scribe_v2' } as never;
  const registry = new ProviderRegistry(new DeepgramProvider(cfg), new ElevenLabsProvider(cfg));

  it.each(Object.values(ProviderKind))('has a speech-to-text adapter for %s', (kind) => {
    expect(registry.speechToTextFor(kind).kind).toBe(kind);
  });
});
