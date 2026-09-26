import { loadJwtConfig } from './jwt-config';

const SECRET = 's'.repeat(48);

describe('loadJwtConfig', () => {
  it('reads the secret and applies default lifetimes', () => {
    expect(loadJwtConfig({ JWT_ACCESS_SECRET: SECRET })).toEqual({
      accessSecret: SECRET,
      accessTtlSeconds: 900,
      refreshTtlSeconds: 604_800,
    });
  });

  it('reads explicit lifetimes', () => {
    const config = loadJwtConfig({
      JWT_ACCESS_SECRET: SECRET,
      JWT_ACCESS_TTL_SECONDS: '600',
      JWT_REFRESH_TTL_SECONDS: '86400',
    });
    expect(config.accessTtlSeconds).toBe(600);
    expect(config.refreshTtlSeconds).toBe(86_400);
  });

  it('treats an empty lifetime as unset rather than zero', () => {
    // An unset var in a .env file often arrives as '' rather than undefined.
    const config = loadJwtConfig({ JWT_ACCESS_SECRET: SECRET, JWT_ACCESS_TTL_SECONDS: '' });
    expect(config.accessTtlSeconds).toBe(900);
  });

  it('refuses to start without a signing secret', () => {
    // Failing at boot is the point: a missing secret discovered on the first
    // login is a production outage, discovered at boot it is a config error.
    expect(() => loadJwtConfig({})).toThrow(/JWT_ACCESS_SECRET is not set/);
    expect(() => loadJwtConfig({ JWT_ACCESS_SECRET: '' })).toThrow(/JWT_ACCESS_SECRET is not set/);
  });

  it('refuses a secret shorter than 32 characters', () => {
    expect(() => loadJwtConfig({ JWT_ACCESS_SECRET: 'short' })).toThrow(/at least 32 characters/);
  });

  it('refuses a lifetime that is not a whole number of seconds', () => {
    expect(() =>
      loadJwtConfig({ JWT_ACCESS_SECRET: SECRET, JWT_ACCESS_TTL_SECONDS: '15m' }),
    ).toThrow(/JWT_ACCESS_TTL_SECONDS must be a whole number of seconds/);
  });

  it('refuses lifetimes outside their allowed ranges', () => {
    expect(() =>
      loadJwtConfig({ JWT_ACCESS_SECRET: SECRET, JWT_ACCESS_TTL_SECONDS: '30' }),
    ).toThrow(/JWT_ACCESS_TTL_SECONDS must be between 60 and 3600/);
    expect(() =>
      loadJwtConfig({ JWT_ACCESS_SECRET: SECRET, JWT_REFRESH_TTL_SECONDS: '60' }),
    ).toThrow(/JWT_REFRESH_TTL_SECONDS must be between 3600 and 7776000/);
  });
});
