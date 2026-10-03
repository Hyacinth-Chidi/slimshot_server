import { ConfigType, registerAs } from '@nestjs/config';

import { parseEnv } from './env.validation';

export const appAuthConfig = registerAs('appAuth', () => {
  const env = parseEnv(process.env);
  return {
    jwtSecret: env.USER_JWT_SECRET,
    accessTtlSeconds: env.USER_ACCESS_TTL_SECONDS,
    refreshTtlSeconds: env.USER_REFRESH_TTL_SECONDS,
    identityHmacSecret: env.IDENTITY_HMAC_SECRET,
    googleClientIds: env.GOOGLE_CLIENT_IDS,
  };
});

export type AppAuthConfig = ConfigType<typeof appAuthConfig>;
