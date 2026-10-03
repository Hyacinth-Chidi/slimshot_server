import { ConfigType, registerAs } from '@nestjs/config';

import { parseEnv } from './env.validation';

export const emailConfig = registerAs('email', () => {
  const env = parseEnv(process.env);
  return {
    sender: env.EMAIL_SENDER,
    from: env.EMAIL_FROM ?? 'SlimShot <no-reply@localhost>',
    smtp: {
      host: env.SMTP_HOST ?? '',
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      user: env.SMTP_USER,
      password: env.SMTP_PASSWORD,
    },
  };
});

export type EmailConfig = ConfigType<typeof emailConfig>;
