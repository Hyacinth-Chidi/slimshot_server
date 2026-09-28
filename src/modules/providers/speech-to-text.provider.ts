import { ProviderKind } from '../../generated/prisma/enums';

export interface CaptionWord {
  /** One spoken word, punctuation attached ("channel."). */
  text: string;
  /** Seconds from the start of the uploaded audio. */
  start: number;
  end: number;
  /** 0–1. */
  confidence: number;
}

export interface CaptionResult {
  provider: ProviderKind;
  /** The code the app asked for, else the provider's detected code (en, eng, …). */
  language: string | null;
  durationSeconds: number | null;
  text: string;
  words: CaptionWord[];
}

export interface TranscribeInput {
  filePath: string;
  mimeType: string;
  language?: string;
}

export interface KeyCheck {
  ok: boolean;
  message: string;
}

/**
 * One speech-to-text vendor. Adding a vendor is one class implementing this
 * plus one ProviderKind value; nothing else learns its name.
 */
export interface SpeechToTextProvider {
  readonly kind: ProviderKind;
  transcribe(input: TranscribeInput, apiKey: string): Promise<CaptionResult>;
  testKey(apiKey: string): Promise<KeyCheck>;
}

export const PROVIDER_NAMES: Record<ProviderKind, string> = {
  [ProviderKind.deepgram]: 'Deepgram',
  [ProviderKind.elevenlabs]: 'ElevenLabs',
};
