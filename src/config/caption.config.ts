import { ConfigType, registerAs } from '@nestjs/config';

import { parseEnv } from './env.validation';

export const captionConfig = registerAs('caption', () => {
  const env = parseEnv(process.env);
  return {
    tmpDir: env.CAPTION_TMP_DIR,
    maxUploadBytes: env.CAPTION_MAX_UPLOAD_BYTES,
    resultTtlSeconds: env.CAPTION_RESULT_TTL_SECONDS,
    concurrency: env.CAPTION_CONCURRENCY,
    deepgramModel: env.CAPTION_DEEPGRAM_MODEL,
    elevenlabsModel: env.CAPTION_ELEVENLABS_MODEL,
  };
});

export type CaptionConfig = ConfigType<typeof captionConfig>;
