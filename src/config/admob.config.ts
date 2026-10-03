import { ConfigType, registerAs } from '@nestjs/config';

import { parseEnv } from './env.validation';

export const admobConfig = registerAs('admob', () => {
  const env = parseEnv(process.env);
  return { adUnitIds: env.ADMOB_AD_UNIT_IDS, verifierKeysUrl: env.ADMOB_VERIFIER_KEYS_URL };
});

export type AdmobConfig = ConfigType<typeof admobConfig>;
