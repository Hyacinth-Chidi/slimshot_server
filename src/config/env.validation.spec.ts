import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { admobConfig } from './admob.config';
import { appAuthConfig } from './app-auth.config';
import { appConfig } from './app.config';
import { authConfig } from './auth.config';
import { captionConfig } from './caption.config';
import { cryptoConfig } from './crypto.config';
import { emailConfig } from './email.config';
import { parseEnv } from './env.validation';
import { uploadConfig } from './upload.config';

const BASE = {
  DATABASE_URL: 'postgresql://u:p@host/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 's'.repeat(48),
  CLOUDINARY_CLOUD_NAME: 'demo',
  CLOUDINARY_API_KEY: 'key',
  CLOUDINARY_API_SECRET: 'secret',
  MASTER_ENCRYPTION_KEY: 'ab'.repeat(32),
  USER_JWT_SECRET: 'u'.repeat(48),
  IDENTITY_HMAC_SECRET: 'i'.repeat(48),
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
    'MASTER_ENCRYPTION_KEY',
    'USER_JWT_SECRET',
    'IDENTITY_HMAC_SECRET',
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
    ['CAPTION_MAX_UPLOAD_BYTES', '1000'],
    ['CAPTION_MAX_UPLOAD_BYTES', '209715201'],
    ['CAPTION_RESULT_TTL_SECONDS', '29'],
    ['CAPTION_RESULT_TTL_SECONDS', '3601'],
    ['CAPTION_CONCURRENCY', '0'],
    ['CAPTION_CONCURRENCY', '21'],
    ['MASTER_ENCRYPTION_KEY', 'a'.repeat(63)],
    ['MASTER_ENCRYPTION_KEY', 'g'.repeat(64)],
    ['USER_ACCESS_TTL_SECONDS', '30'],
    ['USER_REFRESH_TTL_SECONDS', '60'],
    ['EMAIL_SENDER', 'pigeon'],
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

  it('applies the auto caption defaults', () => {
    expect(parseEnv(BASE)).toMatchObject({
      CAPTION_TMP_DIR: join(tmpdir(), 'slimshot-captions'),
      CAPTION_MAX_UPLOAD_BYTES: 52_428_800,
      CAPTION_RESULT_TTL_SECONDS: 180,
      CAPTION_CONCURRENCY: 4,
      CAPTION_DEEPGRAM_MODEL: 'nova-3',
      CAPTION_ELEVENLABS_MODEL: 'scribe_v2',
    });
  });

  it('applies the account defaults', () => {
    expect(parseEnv(BASE)).toMatchObject({
      USER_ACCESS_TTL_SECONDS: 900,
      USER_REFRESH_TTL_SECONDS: 2_592_000,
      GOOGLE_CLIENT_IDS: [],
      EMAIL_SENDER: 'log',
      SMTP_PORT: 587,
      SMTP_SECURE: false,
      ADMOB_AD_UNIT_IDS: [],
      ADMOB_VERIFIER_KEYS_URL: 'https://www.gstatic.com/admob/reward/verifier-keys.json',
      TRUST_PROXY: false,
    });
  });

  it('refuses a user token secret equal to the admin one', () => {
    expect(() => parseEnv({ ...BASE, USER_JWT_SECRET: BASE.JWT_ACCESS_SECRET })).toThrow(
      'USER_JWT_SECRET must differ from JWT_ACCESS_SECRET',
    );
  });

  it('requires the SMTP host and sender address for smtp', () => {
    let message = '';
    try {
      parseEnv({ ...BASE, EMAIL_SENDER: 'smtp' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('SMTP_HOST is required when EMAIL_SENDER=smtp');
    expect(message).toContain('EMAIL_FROM is required when EMAIL_SENDER=smtp');
  });

  it('refuses the log email sender and missing ad units in production', () => {
    let message = '';
    try {
      parseEnv({ ...BASE, NODE_ENV: 'production' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('EMAIL_SENDER=log');
    expect(message).toContain('ADMOB_AD_UNIT_IDS is required in production');
  });

  it.each([
    ['true', true],
    ['false', false],
    ['1', 1],
    ['', false],
  ])('parses TRUST_PROXY=%j', (raw, parsed) => {
    expect(parseEnv({ ...BASE, TRUST_PROXY: raw }).TRUST_PROXY).toBe(parsed);
  });

  it('rejects a TRUST_PROXY that is not true, false or a hop count', () => {
    expect(() => parseEnv({ ...BASE, TRUST_PROXY: 'yes' })).toThrow('TRUST_PROXY');
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

  it('exposes caption settings', () => {
    // Not spread over the real environment: a CAPTION_* in the developer's
    // shell must not change what this asserts.
    process.env = { ...BASE, CAPTION_CONCURRENCY: '2', CAPTION_TMP_DIR: ' /var/tmp/captions ' };
    expect(captionConfig()).toEqual({
      tmpDir: '/var/tmp/captions',
      maxUploadBytes: 52_428_800,
      resultTtlSeconds: 180,
      concurrency: 2,
      deepgramModel: 'nova-3',
      elevenlabsModel: 'scribe_v2',
    });
  });

  it('exposes app-user auth, email and AdMob settings', () => {
    process.env = {
      ...BASE,
      GOOGLE_CLIENT_IDS: 'web-1.apps.googleusercontent.com',
      EMAIL_SENDER: 'smtp',
      SMTP_HOST: 'smtp.example.com',
      EMAIL_FROM: 'SlimShot <no-reply@example.com>',
      ADMOB_AD_UNIT_IDS: 'ca-app-pub-1/2',
      TRUST_PROXY: '1',
    };
    expect(appAuthConfig()).toEqual({
      jwtSecret: 'u'.repeat(48),
      accessTtlSeconds: 900,
      refreshTtlSeconds: 2_592_000,
      identityHmacSecret: 'i'.repeat(48),
      googleClientIds: ['web-1.apps.googleusercontent.com'],
    });
    expect(emailConfig()).toEqual({
      sender: 'smtp',
      from: 'SlimShot <no-reply@example.com>',
      smtp: { host: 'smtp.example.com', port: 587, secure: false, user: undefined, password: undefined },
    });
    expect(admobConfig()).toEqual({
      adUnitIds: ['ca-app-pub-1/2'],
      verifierKeysUrl: 'https://www.gstatic.com/admob/reward/verifier-keys.json',
    });
    expect(appConfig().trustProxy).toBe(1);
  });

  it('exposes the master encryption key', () => {
    process.env = { ...BASE };
    expect(cryptoConfig().masterKey).toBe('ab'.repeat(32));
  });

  it('keys upload limits by asset kind', () => {
    process.env = { ...original, ...BASE, UPLOAD_AUDIO_MAX_BYTES: '1000' };
    expect(uploadConfig().limits.audio).toEqual({
      maxBytes: 1000,
      mimeTypes: ['audio/mpeg', 'audio/wav', 'audio/aac', 'audio/ogg', 'audio/flac'],
    });
  });
});
