import { ConfigType, registerAs } from '@nestjs/config';

import { parseEnv } from './env.validation';

export const appConfig = registerAs('app', () => {
  const env = parseEnv(process.env);
  // The dashboard's origin is always allowed; any extra origins add to it.
  const corsOrigins = [
    ...new Set([...env.CORS_ALLOWED_ORIGINS, ...(env.ADMIN_BASE_URL ? [env.ADMIN_BASE_URL] : [])]),
  ];
  return { nodeEnv: env.NODE_ENV, port: env.PORT, corsOrigins };
});

export type AppConfig = ConfigType<typeof appConfig>;
