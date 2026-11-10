import { ProviderCapability, ProviderKind } from '../../generated/prisma/enums';
import type { KeyCheck } from './speech-to-text.provider';

/** A voice as the provider lists it. */
export interface ProviderVoice {
  providerVoiceId: string;
  name: string | null;
}

export interface SynthesizeInput {
  text: string;
  /** The provider's own id for the voice. */
  voiceId: string;
}

/**
 * One text-to-speech vendor. Adding a vendor is one class implementing this,
 * one ProviderKind value and its place in CAPABLE_PROVIDERS.
 */
export interface TextToSpeechProvider {
  readonly kind: ProviderKind;
  /** The spoken text as MP3 bytes. */
  synthesize(input: SynthesizeInput, apiKey: string): Promise<Buffer>;
  listVoices(apiKey: string): Promise<ProviderVoice[]>;
  testKey(apiKey: string): Promise<KeyCheck>;
}

/** Which providers can do each job. A key is only taken for a provider listed here. */
export const CAPABLE_PROVIDERS: Record<ProviderCapability, ProviderKind[]> = {
  [ProviderCapability.speech_to_text]: [ProviderKind.deepgram, ProviderKind.elevenlabs, ProviderKind.xai],
  [ProviderCapability.text_to_speech]: [ProviderKind.xai],
};
