import { ConfigType, registerAs } from '@nestjs/config';

import { parseEnv } from './env.validation';

export const speechConfig = registerAs('speech', () => {
  const env = parseEnv(process.env);
  return {
    tmpDir: env.TTS_TMP_DIR,
    keepMinutes: env.TTS_KEEP_MINUTES,
    concurrency: env.TTS_CONCURRENCY,
    maxItemCharacters: env.TTS_MAX_ITEM_CHARACTERS,
    maxRequestCharacters: env.TTS_MAX_REQUEST_CHARACTERS,
    maxItems: env.TTS_MAX_ITEMS,
  };
});

export type SpeechConfig = ConfigType<typeof speechConfig>;
