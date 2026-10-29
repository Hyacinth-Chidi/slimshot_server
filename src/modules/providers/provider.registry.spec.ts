import { ProviderKind } from '../../generated/prisma/enums';
import { DeepgramProvider } from './deepgram.provider';
import { ElevenLabsProvider } from './elevenlabs.provider';
import { ProviderRegistry } from './provider.registry';
import { XaiProvider } from './xai.provider';

describe('ProviderRegistry', () => {
  const cfg = { deepgramModel: 'nova-3', elevenlabsModel: 'scribe_v2', xaiModel: 'grok-voice-transcribe-2.0' } as never;
  const registry = new ProviderRegistry(new DeepgramProvider(cfg), new ElevenLabsProvider(cfg), new XaiProvider(cfg));

  it.each(Object.values(ProviderKind))('has a speech-to-text adapter for %s', (kind) => {
    expect(registry.speechToTextFor(kind).kind).toBe(kind);
  });
});
