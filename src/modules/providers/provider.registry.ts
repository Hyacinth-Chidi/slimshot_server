import { Injectable } from '@nestjs/common';

import { ProviderKind } from '../../generated/prisma/enums';
import { DeepgramProvider } from './deepgram.provider';
import { ElevenLabsProvider } from './elevenlabs.provider';
import type { SpeechToTextProvider } from './speech-to-text.provider';
import type { TextToSpeechProvider } from './text-to-speech.provider';
import { XaiTextToSpeechProvider } from './xai-tts.provider';
import { XaiProvider } from './xai.provider';

@Injectable()
export class ProviderRegistry {
  private readonly speechToText: ReadonlyMap<ProviderKind, SpeechToTextProvider>;
  private readonly textToSpeech: ReadonlyMap<ProviderKind, TextToSpeechProvider>;

  constructor(
    deepgram: DeepgramProvider,
    elevenlabs: ElevenLabsProvider,
    xai: XaiProvider,
    xaiSpeech: XaiTextToSpeechProvider,
  ) {
    this.speechToText = new Map<ProviderKind, SpeechToTextProvider>([
      [deepgram.kind, deepgram],
      [elevenlabs.kind, elevenlabs],
      [xai.kind, xai],
    ]);
    this.textToSpeech = new Map<ProviderKind, TextToSpeechProvider>([[xaiSpeech.kind, xaiSpeech]]);
  }

  textToSpeechFor(kind: ProviderKind): TextToSpeechProvider {
    const adapter = this.textToSpeech.get(kind);
    // CAPABLE_PROVIDERS names who may hold a text-to-speech key, so this means
    // a provider was listed there without its adapter.
    if (!adapter) throw new Error(`No text-to-speech adapter is registered for ${kind}.`);
    return adapter;
  }

  speechToTextFor(kind: ProviderKind): SpeechToTextProvider {
    const adapter = this.speechToText.get(kind);
    // The registry spec pins one adapter per ProviderKind, so this means a new
    // enum value shipped without its adapter.
    if (!adapter) throw new Error(`No speech-to-text adapter is registered for ${kind}.`);
    return adapter;
  }
}
