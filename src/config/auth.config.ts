import { ConfigType, registerAs } from '@nestjs/config';

import { parseEnv } from './env.validation';

export const authConfig = registerAs('auth', () => {
  const env = parseEnv(process.env);
  return {
    jwt: {
      accessSecret: env.JWT_ACCESS_SECRET,
      accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
      refreshTtlSeconds: env.JWT_REFRESH_TTL_SECONDS,
    },
    login: {
      maxAttempts: env.AUTH_LOGIN_MAX_ATTEMPTS,
      lockoutSeconds: env.AUTH_LOGIN_LOCKOUT_SECONDS,
    },
    // Validation guarantees the password exists whenever the email does.
    bootstrap:
      env.ADMIN_BOOTSTRAP_EMAIL && env.ADMIN_BOOTSTRAP_PASSWORD
        ? { email: env.ADMIN_BOOTSTRAP_EMAIL, password: env.ADMIN_BOOTSTRAP_PASSWORD }
        : null,
  };
});

export type AuthConfig = ConfigType<typeof authConfig>;
