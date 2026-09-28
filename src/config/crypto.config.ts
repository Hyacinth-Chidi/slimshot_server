import { ConfigType, registerAs } from '@nestjs/config';

import { parseEnv } from './env.validation';

export const cryptoConfig = registerAs('crypto', () => ({
  masterKey: parseEnv(process.env).MASTER_ENCRYPTION_KEY,
}));

export type CryptoConfig = ConfigType<typeof cryptoConfig>;
