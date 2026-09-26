import { ConfigType, registerAs } from '@nestjs/config';

import { parseEnv } from './env.validation';

export const cloudinaryConfig = registerAs('cloudinary', () => {
  const env = parseEnv(process.env);
  return {
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    apiKey: env.CLOUDINARY_API_KEY,
    apiSecret: env.CLOUDINARY_API_SECRET,
    folder: env.CLOUDINARY_AUDIO_FOLDER,
  };
});

export type CloudinaryEnvConfig = ConfigType<typeof cloudinaryConfig>;
