import { appConfig } from './app.config';
import { authConfig } from './auth.config';
import { parseEnv } from './env.validation';
import { uploadConfig } from './upload.config';

const BASE = {
  DATABASE_URL: 'postgresql://u:p@host/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 's'.repeat(48),
  CLOUDINARY_CLOUD_NAME: 'demo',
  CLOUDINARY_API_KEY: 'key',
  CLOUDINARY_API_SECRET: 'secret',
};

describe('parseEnv', () => {
  it('accepts the required variables and applies every default', () => {
    const env = parseEnv(BASE);
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      PORT: 2700,
      CORS_ALLOWED_ORIGINS: [],
      JWT_ACCESS_TTL_SECONDS: 900,
      JWT_REFRESH_TTL_SECONDS: 604_800,
      AUTH_LOGIN_MAX_ATTEMPTS: 5,
      AUTH_LOGIN_LOCKOUT_SECONDS: 900,
      UPLOAD_AUDIO_MAX_BYTES: 52_428_800,
      UPLOAD_AUDIO_MIME_TYPES: ['audio/mpeg', 'audio/wav', 'audio/aac', 'audio/ogg', 'audio/flac'],
      UPLOAD_TICKET_TTL_SECONDS: 900,
      CLOUDINARY_AUDIO_FOLDER: 'slimshot/audio',
    });
    expect(env.ADMIN_BASE_URL).toBeUndefined();
    expect(env.ADMIN_BOOTSTRAP_EMAIL).toBeUndefined();
  });

  it('parses explicit numbers and comma lists', () => {
    const env = parseEnv({
      ...BASE,
      PORT: '3000',
      UPLOAD_AUDIO_MIME_TYPES: 'audio/mpeg, audio/wav ,',
      CORS_ALLOWED_ORIGINS: 'https://a.example.com,http://localhost:3001',
    });
    expect(env.PORT).toBe(3000);
    expect(env.UPLOAD_AUDIO_MIME_TYPES).toEqual(['audio/mpeg', 'audio/wav']);
    expect(env.CORS_ALLOWED_ORIGINS).toEqual(['https://a.example.com', 'http://localhost:3001']);
  });

  it('treats an empty value as unset, so the default applies', () => {
    // A `.env` line with nothing after `=` arrives as ''. Number('') is 0.
    const env = parseEnv({ ...BASE, UPLOAD_AUDIO_MAX_BYTES: '', PORT: '   ' });
    expect(env.UPLOAD_AUDIO_MAX_BYTES).toBe(52_428_800);
    expect(env.PORT).toBe(2700);
  });

  it('trims stray whitespace around values', () => {
    const env = parseEnv({ ...BASE, CLOUDINARY_CLOUD_NAME: ' dtdvob79f ' });
    expect(env.CLOUDINARY_CLOUD_NAME).toBe('dtdvob79f');
  });

  it('strips trailing slashes from CORS origins, which browsers never send', () => {
    // A browser's Origin header is scheme + host + port, no path; an entry with
    // a trailing slash would never match and would silently block that site.
    const env = parseEnv({ ...BASE, CORS_ALLOWED_ORIGINS: 'https://a.example.com/, http://localhost:3001//' });
    expect(env.CORS_ALLOWED_ORIGINS).toEqual(['https://a.example.com', 'http://localhost:3001']);
  });

  it('strips a trailing slash from ADMIN_BASE_URL', () => {
    expect(parseEnv({ ...BASE, ADMIN_BASE_URL: 'http://localhost:3001/' }).ADMIN_BASE_URL).toBe(
      'http://localhost:3001',
    );
  });

  it.each([
    'DATABASE_URL',
    'REDIS_URL',
    'JWT_ACCESS_SECRET',
    'CLOUDINARY_CLOUD_NAME',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET',
  ])('rejects a missing or empty %s', (name) => {
    const without: Record<string, unknown> = { ...BASE };
    delete without[name];
    expect(() => parseEnv(without)).toThrow(name);
    expect(() => parseEnv({ ...BASE, [name]: '' })).toThrow(name);
  });

  it.each([
    ['PORT', '0'],
    ['PORT', '70000'],
    ['JWT_ACCESS_TTL_SECONDS', '30'],
    ['JWT_REFRESH_TTL_SECONDS', '60'],
    ['AUTH_LOGIN_MAX_ATTEMPTS', '0'],
    ['AUTH_LOGIN_LOCKOUT_SECONDS', '10'],
    ['UPLOAD_AUDIO_MAX_BYTES', '0'],
    ['UPLOAD_TICKET_TTL_SECONDS', '59'],
    ['PORT', '15m'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => parseEnv({ ...BASE, [name]: value })).toThrow(name);
  });

  it('rejects a short JWT secret, a non-redis URL and a bad NODE_ENV', () => {
    expect(() => parseEnv({ ...BASE, JWT_ACCESS_SECRET: 'short' })).toThrow('JWT_ACCESS_SECRET');
    expect(() => parseEnv({ ...BASE, REDIS_URL: 'http://x' })).toThrow('REDIS_URL');
    expect(() => parseEnv({ ...BASE, NODE_ENV: 'staging' })).toThrow('NODE_ENV');
  });

  it('requires a bootstrap password when a bootstrap email is set', () => {
    expect(() => parseEnv({ ...BASE, ADMIN_BOOTSTRAP_EMAIL: 'o@example.com' })).toThrow(
      'ADMIN_BOOTSTRAP_PASSWORD',
    );
    expect(() =>
      parseEnv({ ...BASE, ADMIN_BOOTSTRAP_EMAIL: 'not-an-email', ADMIN_BOOTSTRAP_PASSWORD: 'x' }),
    ).toThrow('ADMIN_BOOTSTRAP_EMAIL');
  });

  it('reports every problem in one error', () => {
    // One restart per mistake is how a broken deploy eats an afternoon.
    let message = '';
    try {
      parseEnv({ ...BASE, PORT: '0', JWT_ACCESS_SECRET: 'short', REDIS_URL: '' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('PORT');
    expect(message).toContain('JWT_ACCESS_SECRET');
    expect(message).toContain('REDIS_URL');
  });
});

describe('config namespaces', () => {
  const original = process.env;
  afterEach(() => {
    process.env = original;
  });

  it('merges ADMIN_BASE_URL into the CORS origins without duplicates', () => {
    process.env = {
      ...original,
      ...BASE,
      ADMIN_BASE_URL: 'http://localhost:3001/',
      CORS_ALLOWED_ORIGINS: 'http://localhost:3001,https://a.example.com',
    };
    expect(appConfig().corsOrigins).toEqual(['http://localhost:3001', 'https://a.example.com']);
  });

  it('exposes no bootstrap credentials unless both are set', () => {
    process.env = { ...original, ...BASE, ADMIN_BOOTSTRAP_EMAIL: '', ADMIN_BOOTSTRAP_PASSWORD: '' };
    expect(authConfig().bootstrap).toBeNull();
  });

  it('keys upload limits by asset kind', () => {
    process.env = { ...original, ...BASE, UPLOAD_AUDIO_MAX_BYTES: '1000' };
    expect(uploadConfig().limits.audio).toEqual({
      maxBytes: 1000,
      mimeTypes: ['audio/mpeg', 'audio/wav', 'audio/aac', 'audio/ogg', 'audio/flac'],
    });
  });
});
