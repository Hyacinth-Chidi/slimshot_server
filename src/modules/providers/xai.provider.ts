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

const API = 'https://api.x.ai/v1';

interface XaiWord {
  text: string;
  /** Seconds, two decimals. */
  start: number;
  end: number;
  /** 0–1; documented as present, but not on every word in xAI's own examples. */
  confidence?: number;
}

interface XaiResponse {
  text?: string;
  language?: string;
  duration?: number;
  words?: XaiWord[];
}

interface XaiKeyInfo {
  api_key_blocked?: boolean;
  api_key_disabled?: boolean;
  team_blocked?: boolean;
}

/** xAI answers 200 for a key it will not serve, and says why in these flags. */
function keyRefusal(body: unknown): KeyCheck | null {
  const info = (body ?? {}) as XaiKeyInfo;
  if (info.api_key_blocked) return { ok: false, message: 'xAI has blocked this key.' };
  if (info.api_key_disabled) return { ok: false, message: 'This key is disabled in the xAI console.' };
  if (info.team_blocked) return { ok: false, message: 'xAI has blocked the team that owns this key.' };
  return null;
}

/** xAI speech to text (docs.x.ai › Speech to Text): POST /v1/stt, multipart. */
@Injectable()
export class XaiProvider implements SpeechToTextProvider {
  readonly kind = ProviderKind.xai;

  constructor(@Inject(captionConfig.KEY) private readonly cfg: CaptionConfig) {}

  async transcribe(input: TranscribeInput, apiKey: string): Promise<CaptionResult> {
    const audio = await readFile(input.filePath);
    const form = new FormData();
    form.append('model', this.cfg.xaiModel);
    if (input.language) {
      form.append('language', input.language);
      // Writes numbers and currency out ("$167,983.15"); xAI only does it when told the language.
      form.append('format', 'true');
    }
    // xAI requires the file after every other field.
    form.append('file', new Blob([audio], { type: input.mimeType }), 'audio');

    const body = await requestJson<XaiResponse>(
      this.kind,
      `${API}/stt`,
      { method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: form },
      apiKey,
    );

    // Silence is an answer: no words is an empty caption, not a failure.
    const words = (body.words ?? []).map((w) => ({
      text: w.text,
      start: w.start,
      end: w.end,
      confidence: w.confidence ?? 1,
    }));

    return {
      provider: this.kind,
      language: input.language ?? body.language ?? null,
      durationSeconds: body.duration ?? (words.length > 0 ? words[words.length - 1].end : null),
      text: body.text ?? '',
      words,
    };
  }

  testKey(apiKey: string): Promise<KeyCheck> {
    return probeKey(this.kind, `${API}/api-key`, { authorization: `Bearer ${apiKey}` }, apiKey, keyRefusal);
  }
}
