import { Injectable } from '@nestjs/common';

import { ProviderKind } from '../../generated/prisma/enums';
import { DeepgramProvider } from './deepgram.provider';
import { ElevenLabsProvider } from './elevenlabs.provider';
import type { SpeechToTextProvider } from './speech-to-text.provider';

@Injectable()
export class ProviderRegistry {
  private readonly speechToText: ReadonlyMap<ProviderKind, SpeechToTextProvider>;

  constructor(deepgram: DeepgramProvider, elevenlabs: ElevenLabsProvider) {
    this.speechToText = new Map<ProviderKind, SpeechToTextProvider>([
      [deepgram.kind, deepgram],
      [elevenlabs.kind, elevenlabs],
    ]);
  }

  speechToTextFor(kind: ProviderKind): SpeechToTextProvider {
    const adapter = this.speechToText.get(kind);
    // The registry spec pins one adapter per ProviderKind, so this means a new
    // enum value shipped without its adapter.
    if (!adapter) throw new Error(`No speech-to-text adapter is registered for ${kind}.`);
    return adapter;
  }
}
