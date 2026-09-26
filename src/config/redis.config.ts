import { ConfigType, registerAs } from '@nestjs/config';

import { parseEnv } from './env.validation';

export const redisConfig = registerAs('redis', () => ({
  url: parseEnv(process.env).REDIS_URL,
}));

export type RedisConfig = ConfigType<typeof redisConfig>;
