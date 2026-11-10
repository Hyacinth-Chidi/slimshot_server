import { ProviderCapability, ProviderKind } from '../../generated/prisma/enums';
import { DeepgramProvider } from './deepgram.provider';
import { ElevenLabsProvider } from './elevenlabs.provider';
import { ProviderRegistry } from './provider.registry';
import { CAPABLE_PROVIDERS } from './text-to-speech.provider';
import { XaiTextToSpeechProvider } from './xai-tts.provider';
import { XaiProvider } from './xai.provider';

describe('ProviderRegistry', () => {
  const cfg = { deepgramModel: 'nova-3', elevenlabsModel: 'scribe_v2', xaiModel: 'grok-voice-transcribe-2.0' } as never;
  const registry = new ProviderRegistry(
    new DeepgramProvider(cfg),
    new ElevenLabsProvider(cfg),
    new XaiProvider(cfg),
    new XaiTextToSpeechProvider(),
  );

  it.each(Object.values(ProviderKind))('has a speech-to-text adapter for %s', (kind) => {
    expect(registry.speechToTextFor(kind).kind).toBe(kind);
  });

  it('text to speech has an adapter for xAI only', () => {
    expect(CAPABLE_PROVIDERS[ProviderCapability.text_to_speech]).toEqual([ProviderKind.xai]);
    for (const kind of CAPABLE_PROVIDERS[ProviderCapability.text_to_speech]) {
      expect(registry.textToSpeechFor(kind).kind).toBe(kind);
    }
    expect(() => registry.textToSpeechFor(ProviderKind.deepgram)).toThrow();
    expect(() => registry.textToSpeechFor(ProviderKind.elevenlabs)).toThrow();
  });

  it('every provider can turn speech into text', () => {
    expect(CAPABLE_PROVIDERS[ProviderCapability.speech_to_text]).toEqual(Object.values(ProviderKind));
  });
});
