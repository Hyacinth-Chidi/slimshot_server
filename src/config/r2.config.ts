import { ConfigType, registerAs } from '@nestjs/config';

import { parseEnv } from './env.validation';

export const r2Config = registerAs('r2', () => {
  const env = parseEnv(process.env);
  return {
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET,
    publicBaseUrl: env.R2_PUBLIC_BASE_URL,
  };
});

export type R2EnvConfig = ConfigType<typeof r2Config>;
