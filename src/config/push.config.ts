import { ConfigType, registerAs } from '@nestjs/config';

import { decodeServiceAccount, parseEnv } from './env.validation';

/** Push notifications through Firebase Cloud Messaging; off (null) until the key is set. */
export const pushConfig = registerAs('push', () => {
  const env = parseEnv(process.env);
  return {
    serviceAccount: env.FIREBASE_SERVICE_ACCOUNT_BASE64 ? decodeServiceAccount(env.FIREBASE_SERVICE_ACCOUNT_BASE64) : null,
  };
});

export type PushConfig = ConfigType<typeof pushConfig>;
