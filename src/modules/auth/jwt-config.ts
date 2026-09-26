/**
 * JWT configuration comes from the environment, not the settings table: the
 * signing secret and token lifetimes are deployment config, and a secret that
 * lives in the database can be read back by anyone who can reveal settings.
 * Only third-party API keys belong in the database.
 */
export interface JwtConfig {
  accessSecret: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
}

export const JWT_CONFIG = Symbol('JWT_CONFIG');

const MIN_SECRET_LENGTH = 32;

type Env = Record<string, string | undefined>;

/** Throws on any invalid value, so a misconfigured server fails at boot. */
export function loadJwtConfig(env: Env = process.env): JwtConfig {
  const accessSecret = env.JWT_ACCESS_SECRET;
  if (!accessSecret) {
    throw new Error(
      'JWT_ACCESS_SECRET is not set. Generate one with ' +
        `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`,
    );
  }
  if (accessSecret.length < MIN_SECRET_LENGTH) {
    throw new Error(`JWT_ACCESS_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  }

  return {
    accessSecret,
    accessTtlSeconds: seconds(env, 'JWT_ACCESS_TTL_SECONDS', 900, 60, 3_600),
    refreshTtlSeconds: seconds(env, 'JWT_REFRESH_TTL_SECONDS', 604_800, 3_600, 7_776_000),
  };
}

function seconds(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${name} must be a whole number of seconds, got "${raw}".`);
  }
  const value = Number(raw);
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}, got ${value}.`);
  }
  return value;
}
