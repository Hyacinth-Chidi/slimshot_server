import { Injectable } from '@nestjs/common';

import { ProviderKind } from '../../generated/prisma/enums';
import { probeKey, requestAudio, requestJson } from './provider-http';
import type { KeyCheck } from './speech-to-text.provider';
import type { ProviderVoice, SynthesizeInput, TextToSpeechProvider } from './text-to-speech.provider';
import { keyRefusal } from './xai.provider';

const API = 'https://api.x.ai/v1';

interface XaiVoiceList {
  voices?: Array<{ voice_id?: string; name?: string | null }>;
}

/**
 * xAI text to speech (docs.x.ai › Text to Speech): `POST /v1/tts`, JSON in,
 * audio out. Always MP3 at 24 kHz / 128 kbps — what the app's players and the
 * export's decoder read on every phone — and `language: "auto"`: xAI detects it.
 */
@Injectable()
export class XaiTextToSpeechProvider implements TextToSpeechProvider {
  readonly kind = ProviderKind.xai;

  synthesize(input: SynthesizeInput, apiKey: string): Promise<Buffer> {
    return requestAudio(
      this.kind,
      `${API}/tts`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          text: input.text,
          voice_id: input.voiceId,
          language: 'auto',
          output_format: { codec: 'mp3', sample_rate: 24000, bit_rate: 128000 },
        }),
      },
      apiKey,
    );
  }

  async listVoices(apiKey: string): Promise<ProviderVoice[]> {
    const body = await requestJson<XaiVoiceList>(
      this.kind,
      `${API}/tts/voices`,
      { headers: { authorization: `Bearer ${apiKey}` } },
      apiKey,
    );
    return (body.voices ?? [])
      .filter((v): v is { voice_id: string; name?: string | null } => typeof v.voice_id === 'string' && v.voice_id !== '')
      .map((v) => ({ providerVoiceId: v.voice_id, name: v.name ?? null }));
  }

  testKey(apiKey: string): Promise<KeyCheck> {
    return probeKey(this.kind, `${API}/api-key`, { authorization: `Bearer ${apiKey}` }, apiKey, keyRefusal);
  }
}
