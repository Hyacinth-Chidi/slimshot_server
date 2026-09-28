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

const API = 'https://api.elevenlabs.io/v1';

interface ElevenLabsWord {
  text: string;
  type: 'word' | 'spacing' | 'audio_event';
  start?: number | null;
  end?: number | null;
  logprob?: number;
}

interface ElevenLabsResponse {
  language_code?: string;
  text?: string;
  words?: ElevenLabsWord[];
  audio_duration_secs?: number | null;
}

/** ElevenLabs reports log-probability (−∞…0); the app gets 0–1, three decimals. */
function toConfidence(logprob: number | undefined): number {
  const p = Math.exp(logprob ?? 0);
  if (!Number.isFinite(p)) return 0;
  return Math.round(Math.min(1, Math.max(0, p)) * 1_000) / 1_000;
}

@Injectable()
export class ElevenLabsProvider implements SpeechToTextProvider {
  readonly kind = ProviderKind.elevenlabs;

  constructor(@Inject(captionConfig.KEY) private readonly cfg: CaptionConfig) {}

  async transcribe(input: TranscribeInput, apiKey: string): Promise<CaptionResult> {
    const audio = await readFile(input.filePath);
    const form = new FormData();
    form.append('model_id', this.cfg.elevenlabsModel);
    form.append('file', new Blob([audio], { type: input.mimeType }), 'audio');
    form.append('timestamps_granularity', 'word');
    form.append('tag_audio_events', 'false');
    if (input.language) form.append('language_code', input.language);

    const body = await requestJson<ElevenLabsResponse>(
      this.kind,
      `${API}/speech-to-text`,
      { method: 'POST', headers: { 'xi-api-key': apiKey }, body: form },
      apiKey,
    );

    // Spacing and sound events arrive as "words" too; captions want speech only.
    const words = (body.words ?? [])
      .filter((w) => w.type === 'word')
      .map((w) => {
        const start = w.start ?? 0;
        return { text: w.text, start, end: w.end ?? start, confidence: toConfidence(w.logprob) };
      });

    return {
      provider: this.kind,
      language: input.language ?? body.language_code ?? null,
      durationSeconds: body.audio_duration_secs ?? (words.length > 0 ? words[words.length - 1].end : null),
      text: body.text ?? '',
      words,
    };
  }

  testKey(apiKey: string): Promise<KeyCheck> {
    return probeKey(this.kind, `${API}/user`, { 'xi-api-key': apiKey }, apiKey);
  }
}
