import { readFile } from 'node:fs/promises';

import { Inject, Injectable } from '@nestjs/common';

import { captionConfig, type CaptionConfig } from '../../config';
import { ProviderKind } from '../../generated/prisma/enums';
import { probeKey, requestJson } from './provider-http';
import type {
  CaptionResult,
  KeyCheck,
  SpeechToTextProvider,
  TranscribeInput,
} from './speech-to-text.provider';

const API = 'https://api.deepgram.com/v1';

interface DeepgramWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  confidence: number;
}

interface DeepgramResponse {
  metadata?: { duration?: number };
  results?: {
    channels?: Array<{
      detected_language?: string;
      alternatives?: Array<{ transcript?: string; words?: DeepgramWord[] }>;
    }>;
  };
}

@Injectable()
export class DeepgramProvider implements SpeechToTextProvider {
  readonly kind = ProviderKind.deepgram;

  constructor(@Inject(captionConfig.KEY) private readonly cfg: CaptionConfig) {}

  async transcribe(input: TranscribeInput, apiKey: string): Promise<CaptionResult> {
    const params = new URLSearchParams({
      model: this.cfg.deepgramModel,
      smart_format: 'true',
      punctuate: 'true',
    });
    if (input.language) params.set('language', input.language);
    else params.set('detect_language', 'true');

    const audio = await readFile(input.filePath);
    const body = await requestJson<DeepgramResponse>(
      this.kind,
      `${API}/listen?${params.toString()}`,
      {
        method: 'POST',
        headers: { authorization: `Token ${apiKey}`, 'content-type': input.mimeType },
        body: audio,
      },
      apiKey,
    );

    const channel = body.results?.channels?.[0];
    const alternative = channel?.alternatives?.[0];
    // Silence is an answer: no alternative, or one without words, is an empty
    // caption rather than a failure.
    const words = (alternative?.words ?? []).map((w) => ({
      text: w.punctuated_word ?? w.word,
      start: w.start,
      end: w.end,
      confidence: w.confidence,
    }));

    return {
      provider: this.kind,
      language: input.language ?? channel?.detected_language ?? null,
      durationSeconds: body.metadata?.duration ?? null,
      text: alternative?.transcript ?? '',
      words,
    };
  }

  testKey(apiKey: string): Promise<KeyCheck> {
    return probeKey(this.kind, `${API}/projects`, { authorization: `Token ${apiKey}` }, apiKey);
  }
}
