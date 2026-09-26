import { ConfigType, registerAs } from '@nestjs/config';

import { parseEnv } from './env.validation';

export const databaseConfig = registerAs('database', () => ({
  url: parseEnv(process.env).DATABASE_URL,
}));

export type DatabaseConfig = ConfigType<typeof databaseConfig>;
