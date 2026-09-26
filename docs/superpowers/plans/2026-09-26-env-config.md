# Configuration From the Environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every server setting comes from validated environment variables via the standard `@nestjs/config` pattern; the database-stored settings system, the secret-reveal flow and the crypto module are removed, and the dashboard loses its Settings page.

**Architecture:** One class-validator schema (`src/config/env.validation.ts`) parses and validates `process.env` at boot through `ConfigModule.forRoot({ validate })`. Six `registerAs` namespaces shape it into typed objects that services inject as `ConfigType<typeof x>`. Consumers switch over first (Tasks 2–4) while the old code still compiles; Task 5 deletes the old code and adds the migration; Task 6 updates the dashboard.

**Tech Stack:** NestJS 11, `@nestjs/config` 4, class-validator 0.15, class-transformer 0.5, Prisma 7 (adapter-pg), Jest (server); Next.js 16, React 19, Vitest (dashboard).

**Spec:** `docs/superpowers/specs/2026-09-26-env-config-design.md` (server repo)

**Repos:** server `C:\Users\HP\Desktop\Slimshot workspace\slimshot_server`, dashboard `C:\Users\HP\Desktop\Slimshot workspace\slimshot-admin`.

## Global Constraints

- Work on a new branch `feat/env-config` in each repo, created from the current `main`. Before Task 1, commit the uncommitted work already on each `main` checkout as its own commit on the branch (server: JWT-to-env + error-filter changes; dashboard: sidebar collapse, cursor fix, env/port changes), so plan commits stay reviewable.
- Every commit message ends with exactly one trailer line: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- Never `git stash`, never `--no-verify`.
- **Never run anything against the database.** Do not run `prisma migrate dev/deploy/reset` or `db push`. `npx prisma generate` is allowed (no DB access). The migration SQL is written by hand.
- TypeScript strict, no `any`.
- Server gates before every commit: `npx tsc --noEmit -p tsconfig.json`, `npx eslint src test`, `npx jest`. Dashboard gates: `npx vitest run`, `npm run lint`, `npx tsc --noEmit`, `npm run build`.
- `process.env` may only be read in `src/config/**`, `prisma.config.ts`, `prisma/seed.ts`, `test/**` and `*.spec.ts` (ESLint `no-restricted-properties`).
- Defaults and ranges exactly as the spec's §3 table:
  `NODE_ENV` development|production|test (default development) · `PORT` 1–65535 (2700) · `ADMIN_BASE_URL` optional URL, trailing `/` stripped · `CORS_ALLOWED_ORIGINS` optional comma list of URLs (empty) · `DATABASE_URL` required · `REDIS_URL` required, `redis://` or `rediss://` · `JWT_ACCESS_SECRET` required ≥32 chars · `JWT_ACCESS_TTL_SECONDS` 60–3600 (900) · `JWT_REFRESH_TTL_SECONDS` 3600–7776000 (604800) · `AUTH_LOGIN_MAX_ATTEMPTS` 1–100 (5) · `AUTH_LOGIN_LOCKOUT_SECONDS` 30–86400 (900) · `ADMIN_BOOTSTRAP_EMAIL` optional email · `ADMIN_BOOTSTRAP_PASSWORD` required when the email is set · `UPLOAD_AUDIO_MAX_BYTES` 1–1073741824 (52428800) · `UPLOAD_AUDIO_MIME_TYPES` comma list, non-empty (`audio/mpeg,audio/wav,audio/aac,audio/ogg,audio/flac`) · `UPLOAD_TICKET_TTL_SECONDS` 60–86400 (900) · `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` required · `CLOUDINARY_AUDIO_FOLDER` (slimshot/audio).
- An empty or whitespace-only value counts as unset. Values are trimmed.

## Review Focus

1. **An empty line in `.env`** (`UPLOAD_AUDIO_MAX_BYTES=`) must fall back to the default, never become `0` or crash — Task 1 tests it.
2. **Stray whitespace** (`CLOUDINARY_CLOUD_NAME= dtdvob79f`, which the owner's `.env` has) must be trimmed, or Cloudinary signs with a wrong cloud name — Task 1 tests it.
3. **Several bad variables at once** must all be reported in one boot error, not one per restart — Task 1 tests it.
4. **Existing `StorageProvider` rows** that asset files reference must still resolve to a working adapter (by id and as default) with env credentials, before and after the migration — Task 4 tests it.
5. **The new server started before the migration runs** must not select the dropped column or table — Task 5 checks the generated client selects no `configCipher`/`keyVersion` and nothing references `systemSetting`.

---

### Task 1: Config module (validation + namespaces)

**Files:**
- Create: `src/config/env.validation.ts`, `src/config/env.validation.spec.ts`
- Create: `src/config/app.config.ts`, `src/config/database.config.ts`, `src/config/redis.config.ts`, `src/config/auth.config.ts`, `src/config/upload.config.ts`, `src/config/cloudinary.config.ts`, `src/config/index.ts`
- Modify: `src/app.module.ts:20-23`
- Modify: `test/setup-env.ts`
- Modify: `.env.example`
- Modify: `eslint.config.mjs` (allow-list: add `'src/config/**'`)

**Interfaces:**
- Produces: `parseEnv(raw: Record<string, unknown>): Env` (throws `Error` listing every problem), `validate` (same function, for `ConfigModule`), `type Env`, and six namespaces with their types: `appConfig`/`AppConfig`, `databaseConfig`/`DatabaseConfig`, `redisConfig`/`RedisConfig`, `authConfig`/`AuthConfig`, `uploadConfig`/`UploadConfig`, `cloudinaryConfig`/`CloudinaryEnvConfig`, all re-exported from `src/config/index.ts`.
- `AuthConfig = { jwt: { accessSecret: string; accessTtlSeconds: number; refreshTtlSeconds: number }; login: { maxAttempts: number; lockoutSeconds: number }; bootstrap: { email: string; password: string } | null }`
- `UploadConfig = { ticketTtlSeconds: number; limits: Partial<Record<AssetKind, { maxBytes: number; mimeTypes: string[] }>> }`
- `AppConfig = { nodeEnv: 'development' | 'production' | 'test'; port: number; corsOrigins: string[] }`
- `CloudinaryEnvConfig = { cloudName: string; apiKey: string; apiSecret: string; folder: string }`
- `DatabaseConfig = { url: string }`, `RedisConfig = { url: string }`

- [ ] **Step 1: Write the failing test** `src/config/env.validation.spec.ts`

```ts
import { parseEnv } from './env.validation';

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

  it('strips a trailing slash from ADMIN_BASE_URL', () => {
    expect(parseEnv({ ...BASE, ADMIN_BASE_URL: 'http://localhost:3001/' }).ADMIN_BASE_URL).toBe(
      'http://localhost:3001',
    );
  });

  it.each(['DATABASE_URL', 'REDIS_URL', 'JWT_ACCESS_SECRET', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'])(
    'rejects a missing or empty %s',
    (name) => {
      const without: Record<string, unknown> = { ...BASE };
      delete without[name];
      expect(() => parseEnv(without)).toThrow(name);
      expect(() => parseEnv({ ...BASE, [name]: '' })).toThrow(name);
    },
  );

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
    try {
      parseEnv({ ...BASE, PORT: '0', JWT_ACCESS_SECRET: 'short', REDIS_URL: '' });
      throw new Error('expected parseEnv to throw');
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain('PORT');
      expect(message).toContain('JWT_ACCESS_SECRET');
      expect(message).toContain('REDIS_URL');
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest src/config/env.validation.spec.ts`
Expected: FAIL — `Cannot find module './env.validation'`.

- [ ] **Step 3: Write `src/config/env.validation.ts`**

```ts
import { plainToInstance, Transform, TransformFnParams } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsDefined,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  Min,
  MinLength,
  ValidateIf,
  ValidationError,
  validateSync,
} from 'class-validator';

/** A `.env` line with nothing after `=` arrives as ''. Treat it as unset. */
function blank(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === '';
}

const text = ({ value }: TransformFnParams): unknown => (blank(value) ? undefined : String(value).trim());

const int = (fallback: number) =>
  ({ value }: TransformFnParams): unknown => {
    if (blank(value)) return fallback;
    const s = String(value).trim();
    // Number('15m') is NaN and Number('1e3') is 1000; accept digits only.
    return /^-?\d+$/.test(s) ? Number(s) : s;
  };

const list = (fallback: string[]) =>
  ({ value }: TransformFnParams): unknown => {
    if (blank(value)) return fallback;
    return String(value)
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  };

const origin = ({ value }: TransformFnParams): unknown =>
  blank(value) ? undefined : String(value).trim().replace(/\/+$/, '');

const URL_OPTIONS = { require_tld: false, require_protocol: true, protocols: ['http', 'https'] };

const DEFAULT_MIME_TYPES = ['audio/mpeg', 'audio/wav', 'audio/aac', 'audio/ogg', 'audio/flac'];

export class Env {
  @Transform(({ value }) => (blank(value) ? 'development' : String(value).trim()))
  @IsIn(['development', 'production', 'test'])
  NODE_ENV: 'development' | 'production' | 'test' = 'development';

  @Transform(int(2700)) @IsInt() @Min(1) @Max(65_535)
  PORT = 2700;

  @Transform(origin) @IsOptional() @IsUrl(URL_OPTIONS)
  ADMIN_BASE_URL?: string;

  @Transform(list([])) @IsArray() @IsUrl(URL_OPTIONS, { each: true })
  CORS_ALLOWED_ORIGINS: string[] = [];

  @Transform(text) @IsDefined({ message: 'DATABASE_URL is required' }) @IsString() @IsNotEmpty()
  DATABASE_URL!: string;

  @Transform(text)
  @IsDefined({ message: 'REDIS_URL is required' })
  @Matches(/^rediss?:\/\//, { message: 'REDIS_URL must start with redis:// or rediss://' })
  REDIS_URL!: string;

  @Transform(text)
  @IsDefined({ message: 'JWT_ACCESS_SECRET is required' })
  @IsString()
  @MinLength(32, { message: 'JWT_ACCESS_SECRET must be at least 32 characters' })
  JWT_ACCESS_SECRET!: string;

  @Transform(int(900)) @IsInt() @Min(60) @Max(3_600)
  JWT_ACCESS_TTL_SECONDS = 900;

  @Transform(int(604_800)) @IsInt() @Min(3_600) @Max(7_776_000)
  JWT_REFRESH_TTL_SECONDS = 604_800;

  @Transform(int(5)) @IsInt() @Min(1) @Max(100)
  AUTH_LOGIN_MAX_ATTEMPTS = 5;

  @Transform(int(900)) @IsInt() @Min(30) @Max(86_400)
  AUTH_LOGIN_LOCKOUT_SECONDS = 900;

  @Transform(text) @IsOptional() @IsEmail()
  ADMIN_BOOTSTRAP_EMAIL?: string;

  @Transform(text)
  @ValidateIf((env: Env) => env.ADMIN_BOOTSTRAP_EMAIL !== undefined)
  @IsDefined({ message: 'ADMIN_BOOTSTRAP_PASSWORD is required when ADMIN_BOOTSTRAP_EMAIL is set' })
  @IsString()
  ADMIN_BOOTSTRAP_PASSWORD?: string;

  @Transform(int(52_428_800)) @IsInt() @Min(1) @Max(1_073_741_824)
  UPLOAD_AUDIO_MAX_BYTES = 52_428_800;

  @Transform(list(DEFAULT_MIME_TYPES)) @IsArray() @ArrayNotEmpty() @IsString({ each: true })
  UPLOAD_AUDIO_MIME_TYPES: string[] = DEFAULT_MIME_TYPES;

  @Transform(int(900)) @IsInt() @Min(60) @Max(86_400)
  UPLOAD_TICKET_TTL_SECONDS = 900;

  @Transform(text) @IsDefined({ message: 'CLOUDINARY_CLOUD_NAME is required' }) @IsString()
  CLOUDINARY_CLOUD_NAME!: string;

  @Transform(text) @IsDefined({ message: 'CLOUDINARY_API_KEY is required' }) @IsString()
  CLOUDINARY_API_KEY!: string;

  @Transform(text) @IsDefined({ message: 'CLOUDINARY_API_SECRET is required' }) @IsString()
  CLOUDINARY_API_SECRET!: string;

  @Transform(({ value }) => (blank(value) ? 'slimshot/audio' : String(value).trim())) @IsString()
  CLOUDINARY_AUDIO_FOLDER = 'slimshot/audio';
}

function problemsOf(errors: ValidationError[]): string[] {
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
}

/**
 * Parses and validates the environment. Throws one Error listing every
 * problem, so a misconfigured deploy fails at boot with the full picture.
 */
export function parseEnv(raw: Record<string, unknown>): Env {
  const env = plainToInstance(Env, raw);
  const problems = problemsOf(validateSync(env, { skipMissingProperties: false }));
  if (problems.length > 0) {
    throw new Error(`Invalid environment configuration:\n - ${problems.join('\n - ')}`);
  }
  return env;
}

/** The `validate` hook for `ConfigModule.forRoot`. */
export const validate = parseEnv;
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx jest src/config/env.validation.spec.ts`
Expected: PASS. If a class-validator default message does not name the property for a range/type rule, it does by default (`"PORT must not be less than 1"`); confirm and adjust the test only if the library words it differently, never the rule.

- [ ] **Step 5: Write the six namespaces and the index**

`src/config/app.config.ts`:
```ts
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
```

`src/config/database.config.ts`:
```ts
import { ConfigType, registerAs } from '@nestjs/config';

import { parseEnv } from './env.validation';

export const databaseConfig = registerAs('database', () => ({ url: parseEnv(process.env).DATABASE_URL }));

export type DatabaseConfig = ConfigType<typeof databaseConfig>;
```

`src/config/redis.config.ts`:
```ts
import { ConfigType, registerAs } from '@nestjs/config';

import { parseEnv } from './env.validation';

export const redisConfig = registerAs('redis', () => ({ url: parseEnv(process.env).REDIS_URL }));

export type RedisConfig = ConfigType<typeof redisConfig>;
```

`src/config/auth.config.ts`:
```ts
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
```

`src/config/upload.config.ts`:
```ts
import { ConfigType, registerAs } from '@nestjs/config';

import { AssetKind } from '../generated/prisma/enums';
import { parseEnv } from './env.validation';

export interface UploadLimits {
  maxBytes: number;
  mimeTypes: string[];
}

export const uploadConfig = registerAs('upload', () => {
  const env = parseEnv(process.env);
  // Only kinds with limits here can be uploaded; audio is the only kind today.
  const limits: Partial<Record<AssetKind, UploadLimits>> = {
    [AssetKind.audio]: { maxBytes: env.UPLOAD_AUDIO_MAX_BYTES, mimeTypes: env.UPLOAD_AUDIO_MIME_TYPES },
  };
  return { ticketTtlSeconds: env.UPLOAD_TICKET_TTL_SECONDS, limits };
});

export type UploadConfig = ConfigType<typeof uploadConfig>;
```

`src/config/cloudinary.config.ts`:
```ts
import { ConfigType, registerAs } from '@nestjs/config';

import { parseEnv } from './env.validation';

export const cloudinaryConfig = registerAs('cloudinary', () => {
  const env = parseEnv(process.env);
  return {
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    apiKey: env.CLOUDINARY_API_KEY,
    apiSecret: env.CLOUDINARY_API_SECRET,
    folder: env.CLOUDINARY_AUDIO_FOLDER,
  };
});

export type CloudinaryEnvConfig = ConfigType<typeof cloudinaryConfig>;
```

`src/config/index.ts`:
```ts
export { appConfig, type AppConfig } from './app.config';
export { authConfig, type AuthConfig } from './auth.config';
export { cloudinaryConfig, type CloudinaryEnvConfig } from './cloudinary.config';
export { databaseConfig, type DatabaseConfig } from './database.config';
export { parseEnv, validate, type Env } from './env.validation';
export { redisConfig, type RedisConfig } from './redis.config';
export { uploadConfig, type UploadConfig, type UploadLimits } from './upload.config';
```

Add a test for the namespaces to the same spec file:

```ts
import { appConfig } from './app.config';
import { authConfig } from './auth.config';
import { uploadConfig } from './upload.config';

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
```

Run: `npx jest src/config` — Expected: PASS.

- [ ] **Step 6: Wire into `AppModule`**

Replace `src/app.module.ts:20-23` with:

```ts
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
      validate,
      load: [appConfig, databaseConfig, redisConfig, authConfig, uploadConfig, cloudinaryConfig],
    }),
```

and add `import { appConfig, authConfig, cloudinaryConfig, databaseConfig, redisConfig, uploadConfig, validate } from './config';`.

- [ ] **Step 7: Test env, example, lint rule**

`test/setup-env.ts` becomes:

```ts
process.env.NODE_ENV = 'test';
// Test-only values, never real credentials. Every required variable is set so
// config namespaces can be built in any spec.
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY ?? '0'.repeat(64);
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 't'.repeat(48);
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME ?? 'test-cloud';
process.env.CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY ?? 'test-key';
process.env.CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET ?? 'test-secret';
```

(`MASTER_ENCRYPTION_KEY` stays until Task 5 deletes the crypto module.)

In `.env.example`, under the JWT block add:

```
# Extra browser origins allowed by CORS, comma-separated. ADMIN_BASE_URL is
# always allowed. Leave both empty to allow every origin (development only).
CORS_ALLOWED_ORIGINS=

# Login lockout: failed attempts before lockout, and how long it lasts.
AUTH_LOGIN_MAX_ATTEMPTS=5
AUTH_LOGIN_LOCKOUT_SECONDS=900

# Uploads. Size in bytes (default 50 MB); MIME types comma-separated.
UPLOAD_AUDIO_MAX_BYTES=52428800
UPLOAD_AUDIO_MIME_TYPES=audio/mpeg,audio/wav,audio/aac,audio/ogg,audio/flac
UPLOAD_TICKET_TTL_SECONDS=900
```

and change the Cloudinary comment from "Used by `prisma db seed`…" to `# Cloudinary account used for all uploads (required).`; change the Redis comment to `# Redis for the job queue, cache and rate limiting (required).`

In `eslint.config.mjs`, add `'src/config/**',` as the first entry of the allow-list `files` array, and change the rule message to `'Read configuration by injecting a src/config namespace, not process.env.'`

- [ ] **Step 8: Gates and commit**

Run the server gates. Expected: all pass; the app module now validates env at boot but no consumer uses the namespaces yet.

```bash
git add src/config src/app.module.ts test/setup-env.ts .env.example eslint.config.mjs
git commit -m "feat: load and validate configuration with @nestjs/config

Every variable is parsed and validated once at boot; a bad value stops the
server with one message listing every problem. Six registerAs namespaces
expose it typed. Nothing consumes them yet.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Auth reads config (JWT, lockout, bootstrap)

**Files:**
- Modify: `src/modules/auth/token.service.ts`, `token.service.spec.ts`
- Modify: `src/modules/auth/login-attempt.service.ts`, `login-attempt.service.spec.ts`
- Modify: `src/modules/auth/auth.service.ts`, `auth.service.spec.ts`
- Modify: `src/modules/auth/auth.module.ts`
- Delete: `src/modules/auth/jwt-config.ts`, `src/modules/auth/jwt-config.spec.ts`

**Interfaces:**
- Consumes: `authConfig`, `AuthConfig` from `src/config` (Task 1).
- Produces: `TokenService(prisma, @Inject(authConfig.KEY) config: AuthConfig, jwt)`; `LoginAttemptService(@Inject(authConfig.KEY) config: AuthConfig, audit, redis)`; `AuthService(prisma, passwords, tokens, audit, attempts, @Inject(authConfig.KEY) config: AuthConfig)`. Public methods unchanged. `AuthService` no longer touches settings or elevation grants; `TokenService` no longer revokes grants.

- [ ] **Step 1: Update the tests first**

`token.service.spec.ts`: replace the `CONFIG` constant and `build()`:

```ts
const CONFIG = {
  jwt: {
    accessSecret: 'test-signing-secret-that-is-long-enough',
    accessTtlSeconds: 900,
    refreshTtlSeconds: 604_800,
  },
  login: { maxAttempts: 5, lockoutSeconds: 900 },
  bootstrap: null,
};

function build() {
  const prisma = prismaMock();
  const svc = new TokenService(prisma as never, CONFIG, new JwtService({}));
  return { svc, prisma };
}
```

Remove every `elevation` reference from the spec (the deactivation test keeps its assertions on `revokeFamily` and the thrown error; delete only the `expect(elevation.revokeForAdmin)…` lines).

`login-attempt.service.spec.ts`: replace the settings mock:

```ts
const CONFIG = {
  jwt: { accessSecret: 'x'.repeat(40), accessTtlSeconds: 900, refreshTtlSeconds: 604_800 },
  login: { maxAttempts: 5, lockoutSeconds: 900 },
  bootstrap: null,
};
// ...
const svc = new LoginAttemptService(CONFIG, audit as never, redis as never);
return { svc, redis, audit };
```

Delete any test in this spec about `settings.reveal.*` audit actions (the reveal path is gone in Task 5; the lockout counter behaviour is still tested by the login tests). Add:

```ts
it('uses the configured attempt limit and lockout window', async () => {
  const redis = {
    incr: jest.fn(async () => 1),
    expire: jest.fn(async () => 1),
    get: jest.fn(async () => '2'),
    del: jest.fn(async () => 1),
  };
  const svc = new LoginAttemptService(
    { ...CONFIG, login: { maxAttempts: 2, lockoutSeconds: 60 } },
    { record: jest.fn(async () => undefined) } as never,
    redis as never,
  );
  await expect(svc.assertNotLockedOut('a@example.com')).rejects.toThrow(/too many/i);
  await svc.recordFailure('a@example.com', { action: 'auth.login.failed', entityType: 'AdminUser' }, {});
  expect(redis.expire).toHaveBeenCalledWith('auth:login:fail:a@example.com', 60);
});
```

`auth.service.spec.ts`: in `build()`, remove `settingsValues`, `settings` and `elevation`; build with a config whose bootstrap is set from the test:

```ts
function build(
  opts: { admin?: Record<string, unknown> | null; attempts?: number; bootstrap?: { email: string; password: string } | null } = {},
) {
  // ...prisma, redis, tokens, audit unchanged...
  const config = {
    jwt: { accessSecret: 'x'.repeat(40), accessTtlSeconds: 900, refreshTtlSeconds: 604_800 },
    login: { maxAttempts: 5, lockoutSeconds: 900 },
    bootstrap: opts.bootstrap ?? null,
  };
  const attempts = new LoginAttemptService(config, audit as never, redis as never);
  const svc = new AuthService(prisma as never, passwords, tokens as never, audit as never, attempts, config);
  return { svc, prisma, redis, tokens, audit, passwords };
}
```

Rewrite the bootstrap tests to pass credentials through `build({ admin: null, bootstrap: { email: 'Owner@Example.com', password: 'pw-long-enough' } })` instead of setting `process.env`; assert `prisma.adminUser.create` is called with `email: 'owner@example.com'` and `role: 'owner'`. Keep "does nothing when an admin already exists" and "warns and creates nothing when no bootstrap credentials are set" (`build({ admin: null })`, expect `create` not called). Delete the test `never writes a jwt signing secret into settings` and every `settings.set('auth.bootstrapCompleted'…)` assertion. In the logout test remove the `elevation` assertions; keep `expect(tokens.revokeFamily).toHaveBeenCalledWith('fam-1')`.

- [ ] **Step 2: Run the auth specs and watch them fail**

Run: `npx jest src/modules/auth`
Expected: FAIL — TypeScript errors: constructors take the wrong arguments.

- [ ] **Step 3: Implement**

`token.service.ts`: replace the imports of `JWT_CONFIG, JwtConfig` and `ElevationService` with `import { authConfig, type AuthConfig } from '../../config';`. Constructor:

```ts
  constructor(
    private readonly prisma: PrismaService,
    @Inject(authConfig.KEY) private readonly config: AuthConfig,
    private readonly jwt: JwtService,
  ) {}
```

In `issuePair` use `const { accessSecret, accessTtlSeconds: accessTtl, refreshTtlSeconds: refreshTtl } = this.config.jwt;`. In `verifyAccessToken` use `secret: this.config.jwt.accessSecret`. In `rotate`, delete the `await this.elevation.revokeForAdmin(admin.id);` line and the four comment lines above it that explain grant revocation; keep `await this.revokeFamily(row.familyId);`.

`login-attempt.service.ts`:

```ts
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type Redis from 'ioredis';

import { AuditService } from '../../core/audit/audit.service';
import { REDIS } from '../../core/cache/cache.service';
import { authConfig, type AuthConfig } from '../../config';
```

Constructor `(@Inject(authConfig.KEY) private readonly config: AuthConfig, private readonly audit: AuditService, @Inject(REDIS) private readonly redis: Redis)`. `assertNotLockedOut` uses `const max = this.config.login.maxAttempts;`; `recordFailure` uses `const lockout = this.config.login.lockoutSeconds;`. Update the class comment to: `/** Login-failure budget: counts failed logins per email and locks the email out for a configured window. */`. Update the `attemptKey` comment to `// One counter per email, shared by every login attempt.`

`auth.service.ts`: drop the `ElevationService` and `SettingsService` imports; add `import { Inject } from '@nestjs/common';` (merge into the existing import) and `import { authConfig, type AuthConfig } from '../../config';`. Constructor:

```ts
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly attempts: LoginAttemptService,
    @Inject(authConfig.KEY) private readonly config: AuthConfig,
  ) {}
```

In `logout`, delete the two comment lines and `await this.elevation.revokeForAdmin(row.adminUserId);`. Replace `bootstrap()` with:

```ts
  /**
   * Runs once at boot. Creates the first owner from ADMIN_BOOTSTRAP_EMAIL /
   * ADMIN_BOOTSTRAP_PASSWORD if no admin exists yet. Self-disabling: once an
   * admin exists this does nothing, so the variables can be removed.
   */
  async bootstrap(): Promise<void> {
    const adminCount = await this.prisma.adminUser.count({ where: { deletedAt: null } });
    if (adminCount > 0) return;

    const credentials = this.config.bootstrap;
    if (!credentials) {
      this.logger.warn(
        'No admin accounts exist. Set ADMIN_BOOTSTRAP_EMAIL and ' +
          'ADMIN_BOOTSTRAP_PASSWORD, then restart, to create the first owner.',
      );
      return;
    }

    const email = credentials.email.trim().toLowerCase();
    await this.prisma.adminUser.create({
      data: {
        email,
        name: 'Owner',
        role: AdminRole.owner,
        passwordHash: await this.passwords.hash(credentials.password),
      },
    });
    this.logger.log(`Bootstrapped first owner account: ${email}`);
  }
```

`auth.module.ts`: remove the `JWT_CONFIG` provider, its import and the `ElevationModule` import/entry: `imports: [JwtModule.register({})]`.

Delete `src/modules/auth/jwt-config.ts` and `src/modules/auth/jwt-config.spec.ts` (their checks now live in `env.validation.spec.ts`).

- [ ] **Step 4: Run and watch them pass**

Run: `npx jest src/modules/auth` — Expected: PASS. Then the full server gates.

- [ ] **Step 5: Commit**

```bash
git add -A src/modules/auth
git commit -m "refactor: read JWT, login lockout and bootstrap from env config

Auth no longer reads the settings table or revokes elevation grants, and the
bootstrapCompleted flag is gone: bootstrap already runs only when no admin
exists.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Infrastructure reads config (Redis, queue, Prisma, CORS/port)

**Files:**
- Modify: `src/core/cache/redis.module.ts`, `src/core/queue/queue.module.ts`, `src/prisma/prisma.service.ts`, `src/main.ts`, `eslint.config.mjs` (remove `'src/main.ts'` and `'src/prisma/prisma.service.ts'` from the allow-list)
- Test: `src/prisma/prisma.service.spec.ts` (create)

**Interfaces:**
- Consumes: `redisConfig`/`RedisConfig`, `databaseConfig`/`DatabaseConfig`, `appConfig`/`AppConfig`.
- Produces: `PrismaService(@Inject(databaseConfig.KEY) db: DatabaseConfig)`.

- [ ] **Step 1: Write the failing test** `src/prisma/prisma.service.spec.ts`

```ts
jest.mock('@prisma/adapter-pg', () => ({
  PrismaPg: jest.fn().mockImplementation((opts: unknown) => ({ opts })),
}));

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaService } from './prisma.service';

describe('PrismaService', () => {
  it('connects with the configured database URL, not process.env', () => {
    new PrismaService({ url: 'postgresql://configured/db' });
    expect(PrismaPg).toHaveBeenCalledWith({ connectionString: 'postgresql://configured/db' });
  });
});
```

Run: `npx jest src/prisma` — Expected: FAIL (constructor takes no argument / wrong URL).

- [ ] **Step 2: Implement**

`src/prisma/prisma.service.ts` constructor:

```ts
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { databaseConfig, type DatabaseConfig } from '../config';
import { PrismaClient } from '../generated/prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(databaseConfig.KEY) db: DatabaseConfig) {
    super({ adapter: new PrismaPg({ connectionString: db.url }) });
  }
  // onModuleInit / onModuleDestroy unchanged
}
```

`src/core/cache/redis.module.ts` provider:

```ts
    {
      provide: REDIS,
      inject: [redisConfig.KEY],
      useFactory: (redis: RedisConfig): Redis => new Redis(redis.url, { maxRetriesPerRequest: null }),
    },
```

with `import { redisConfig, type RedisConfig } from '../../config';` replacing the `SettingsService` import.

`src/core/queue/queue.module.ts`:

```ts
    BullModule.forRootAsync({
      inject: [redisConfig.KEY],
      useFactory: (redis: RedisConfig) => ({ connection: { url: redis.url } }),
    }),
```

with the same import replacing `SettingsService`.

`src/main.ts` — replace the settings/CORS block and the port lines:

```ts
import { appConfig, type AppConfig } from './config';
// ...
  const app = await NestFactory.create(AppModule);
  const config = app.get<AppConfig>(appConfig.KEY);

  app.enableShutdownHooks();
  // Empty means allow every origin — acceptable only in development.
  app.enableCors(config.corsOrigins.length > 0 ? { origin: config.corsOrigins, credentials: true } : {});
  // ...pipes and filter unchanged...
  await app.listen(config.port);

  new Logger('Bootstrap').log(
    `Application running on port ${config.port} — http://localhost:${config.port}/api/admin/v1`,
  );
```

Remove the now-unused `SettingsService` import from `main.ts`. In `eslint.config.mjs` remove `'src/main.ts'` and `'src/prisma/prisma.service.ts'` from the allow-list.

- [ ] **Step 3: Run and watch it pass; gates; commit**

Run: `npx jest src/prisma`, then the full server gates. Expected: PASS; lint proves `main.ts` and `prisma.service.ts` no longer touch `process.env`.

```bash
git add src/core/cache/redis.module.ts src/core/queue/queue.module.ts src/prisma src/main.ts eslint.config.mjs
git commit -m "refactor: read Redis, database, CORS and port from env config

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Uploads and storage read config

**Files:**
- Modify: `src/modules/ingest/ingest.service.ts`, `ingest.service.spec.ts`
- Modify: `src/modules/assets/asset-kind.interface.ts:13-14`, `src/modules/assets/kinds/audio/audio.descriptor.ts:22-26`, `audio.descriptor.spec.ts:14-15`, `src/modules/assets/kind-registry.ts:44-47`, `kind-registry.spec.ts:11-12`
- Modify: `src/core/storage/storage.registry.ts`, `storage.registry.spec.ts`, `src/core/storage/storage.module.ts`

**Interfaces:**
- Consumes: `uploadConfig`/`UploadConfig`, `cloudinaryConfig`/`CloudinaryEnvConfig`.
- Produces: `IngestService(prisma, kinds, storage, @Inject(uploadConfig.KEY) upload: UploadConfig, queue, audit)`; `StorageRegistry(prisma, @Inject(cloudinaryConfig.KEY) cloudinary: CloudinaryEnvConfig)`; `KindAccepts = { extensions: string[] }`.

- [ ] **Step 1: Update tests first**

`ingest.service.spec.ts`: replace `settingsValues` and the settings argument:

```ts
  const upload = {
    ticketTtlSeconds: 900,
    limits: { audio: { maxBytes: 52_428_800, mimeTypes: ['audio/mpeg', 'audio/wav'] } },
  };
  const svc = new IngestService(
    prisma as never,
    new KindRegistry([AUDIO_DESCRIPTOR]),
    { getDefault: jest.fn(async () => adapter), get: jest.fn(async () => adapter) } as never,
    upload,
    queue as never,
    { record: jest.fn(async () => undefined) } as never,
  );
```

Add to `describe('IngestService.createTicket')`:

```ts
  it('refuses a kind with no configured upload limits', async () => {
    const { svc } = build();
    (svc as unknown as { upload: { limits: Record<string, unknown> } }).upload.limits = {};
    await expect(svc.createTicket(DTO, 'admin-1')).rejects.toThrow(/not configured/i);
  });
```

`audio.descriptor.spec.ts:14-15`: replace the two setting-key assertions with `expect(AUDIO_DESCRIPTOR.accepts.extensions).toEqual(['.mp3', '.wav', '.aac', '.ogg', '.flac']);`. `kind-registry.spec.ts:11-12`: remove the two `...Setting` lines from the fixture.

`storage.registry.spec.ts`: remove the crypto import, `KEY`, `crypto`, `CONFIG`; rows lose `configCipher`/`keyVersion`; every `new StorageRegistry(x as never, crypto)` becomes `new StorageRegistry(x as never, CLOUDINARY)` with:

```ts
const CLOUDINARY = { cloudName: 'demo', apiKey: 'key-1', apiSecret: 'secret-1', folder: 'slimshot/audio' };
```

Add:

```ts
  it('resolves a provider referenced by id with the env credentials', async () => {
    // Asset files point at a provider row by id; after credentials left the
    // database, that lookup must still yield a working adapter.
    const reg = new StorageRegistry(prismaWith([row({ id: 'prov-legacy', isDefault: false })]) as never, CLOUDINARY);
    const adapter = await reg.get('prov-legacy');
    expect(adapter.id).toBe('prov-legacy');
    expect(adapter.kind).toBe('cloudinary');
  });
```

Keep the existing "caches", "rebuilds after invalidation", "no default provider" and "unsupported kind" tests with the new constructor argument.

- [ ] **Step 2: Run and watch them fail**

Run: `npx jest src/modules/ingest src/modules/assets src/core/storage` — Expected: FAIL (constructor/type errors).

- [ ] **Step 3: Implement**

`asset-kind.interface.ts`: `KindAccepts` becomes `{ /** File extensions the dashboard's picker accepts. Size and MIME limits come from upload config. */ extensions: string[]; }`.

`audio.descriptor.ts`: `accepts: { extensions: ['.mp3', '.wav', '.aac', '.ogg', '.flac'] },`.

`kind-registry.ts:44-47` comment becomes: `/** Allowed mime types and the size cap come from upload config and are passed in, so this class stays synchronous and config-free. */`

`ingest.service.ts`: replace the `SettingsService` import with `import { Inject } from '@nestjs/common'` (merge into the existing import) and `import { uploadConfig, type UploadConfig, type UploadLimits } from '../../config';`. Constructor argument `private readonly settings: SettingsService` becomes `@Inject(uploadConfig.KEY) private readonly upload: UploadConfig`. Add a private helper:

```ts
  private limitsFor(kind: AssetKind): UploadLimits {
    const limits = this.upload.limits[kind];
    if (!limits) throw new BadRequestException(`Uploads are not configured for ${kind}.`);
    return limits;
  }
```

In `createTicket` replace the two settings reads with `const { mimeTypes: allowedMimeTypes, maxBytes } = this.limitsFor(dto.kind);` and `const ttlSeconds = this.upload.ticketTtlSeconds;`. In `finalize` replace the settings read with `const allowedMimeTypes = this.limitsFor(kind).mimeTypes;` (keep `const descriptor = this.kinds.get(kind);` only if still used below; otherwise delete it).

`storage.registry.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';

import { cloudinaryConfig, type CloudinaryEnvConfig } from '../../config';
import { PrismaService } from '../../prisma/prisma.service';
import { CloudinaryAdapter } from './adapters/cloudinary.adapter';
import { StorageProviderAdapter } from './storage-adapter.interface';

/** Provider rows are identity only (what asset files point at); credentials come from env. */
interface ProviderRow {
  id: string;
  kind: string;
}

@Injectable()
export class StorageRegistry {
  private readonly adapters = new Map<string, StorageProviderAdapter>();
  private defaultId?: string;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(cloudinaryConfig.KEY) private readonly cloudinary: CloudinaryEnvConfig,
  ) {}
```

Both queries select only identity columns, so the new server never reads the columns Task 5 drops:

```ts
    const row = (await this.prisma.storageProvider.findFirst({
      where: { isDefault: true, isActive: true },
      select: { id: true, kind: true },
    })) as ProviderRow | null;
```

```ts
    const row = (await this.prisma.storageProvider.findUnique({
      where: { id },
      select: { id: true, kind: true },
    })) as ProviderRow | null;
```

`build`:

```ts
  private build(row: ProviderRow): StorageProviderAdapter {
    switch (row.kind) {
      case 'cloudinary':
        return new CloudinaryAdapter(row.id, this.cloudinary);
      default:
        throw new Error(`Unsupported storage kind: ${row.kind}`);
    }
  }
```

Update the `invalidate` comment to `/** Drop cached clients (used by tests; config only changes on restart). */`. In the "no default provider" error message replace "Create one via the admin API." with "Run `npx prisma db seed`.".

`storage.module.ts`: remove the `CryptoModule` import and `imports: [CryptoModule]`.

- [ ] **Step 4: Run and watch them pass; gates; commit**

Run: `npx jest src/modules/ingest src/modules/assets src/core/storage`, then the full server gates. Expected: PASS.

```bash
git add src/modules/ingest src/modules/assets src/core/storage
git commit -m "refactor: read upload limits and Cloudinary credentials from env config

Provider rows stay as the identity asset files reference; the registry builds
the Cloudinary adapter from env and selects only identity columns.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Remove the settings system, grants and crypto; migration

**Files:**
- Delete: `src/core/settings/` (all), `src/core/auth/elevation.module.ts`, `elevation.service.ts`, `elevation.service.spec.ts`, `src/core/crypto/` (all), `src/modules/admin/admin-settings.controller.ts`, `admin-settings.controller.spec.ts`, `settings-admin.service.ts`, `settings-admin.service.spec.ts`, `reveal-callers.spec.ts`, `src/modules/admin/dto/reveal-secret.dto.ts`, `update-setting.dto.ts`
- Modify: `src/app.module.ts`, `src/modules/admin/admin.module.ts`, `src/core/auth/permissions.ts`, `permissions.spec.ts:14-18`, `permissions.guard.spec.ts:44-48`, `src/core/auth/admin-routes.spec.ts:10,31`, `src/core/errors/error-codes.ts`, `src/core/audit/audit.service.spec.ts` (only if it imports removed code), `eslint.config.mjs`, `prisma/schema.prisma:205-216,225-239`, `prisma/seed.ts`, `.env.example`, `test/setup-env.ts`
- Create: `prisma/migrations/20260926120000_config_from_env/migration.sql`

**Interfaces:**
- Consumes: everything from Tasks 1–4 (no file still imports the removed code).
- Produces: `PERMISSIONS` without `settings.read`/`settings.write`; `ErrorCode` without `SETTING_INVALID`; `StorageProvider` without `configCipher`/`keyVersion`; no `SystemSetting` model.

- [ ] **Step 1: Confirm nothing else depends on the code being removed**

Run:
```bash
grep -rln "core/settings\|SettingsService\|SettingsModule\|ElevationService\|ElevationModule\|EnvelopeCrypto\|CryptoModule\|SettingsAdminService\|AdminSettingsController\|revealSecret\|SETTING_INVALID\|settings\.read\|settings\.write" src prisma test
```
Expected: only the files this task deletes or modifies. Anything else is a missed consumer: switch it to config before deleting.

- [ ] **Step 2: Update the permission and route tests first**

`permissions.spec.ts:14-18` becomes:

```ts
  it('only owner may manage admins', () => {
    expect(roleHas(AdminRole.owner, 'admin.manage')).toBe(true);
    expect(roleHas(AdminRole.admin, 'admin.manage')).toBe(false);
    expect(roleHas(AdminRole.editor, 'admin.manage')).toBe(false);
  });
```

Add: `it('has no settings permissions', () => { expect(PERMISSIONS).not.toContain('settings.read' as never); expect(PERMISSIONS).not.toContain('settings.write' as never); });` (import `PERMISSIONS`).

`permissions.guard.spec.ts:44-48`: `guardRequiring('admin.manage')` and `.toThrow(/admin\.manage/)`.

`admin-routes.spec.ts`: remove the `AdminSettingsController` import and its entry in the controller list.

Run: `npx jest src/core/auth` — Expected: FAIL on "has no settings permissions".

- [ ] **Step 3: Delete and unwire**

Delete every file listed under Delete. Then:
- `app.module.ts`: remove `CryptoModule` and `SettingsModule` (imports and entries).
- `admin.module.ts`: remove `ElevationModule`, `AdminSettingsController`, `SettingsAdminService`: `imports: [AssetsModule, IngestModule, AuthModule, TaxonomyModule]`, `providers: [StatsService]`.
- `permissions.ts`: remove `'settings.read'` and `'settings.write'` from `PERMISSIONS`, `VIEWER` and `OWNER`.
- `error-codes.ts`: remove `SETTING_INVALID`.
- `eslint.config.mjs` allow-list: remove `'src/core/crypto/crypto.module.ts'`, `'src/modules/auth/auth.service.ts'` and the `'src/core/settings/settings.service.ts'` entry with its comment. Keep `'src/config/**'`, `'prisma.config.ts'`, `'test/**'`, `'**/*.spec.ts'`, `'prisma/seed.ts'`.

- [ ] **Step 4: Schema and migration**

In `prisma/schema.prisma` delete the `model SystemSetting { … }` block and the `configCipher` and `keyVersion` lines of `model StorageProvider`. Run `npx prisma generate` (no database access).

Create `prisma/migrations/20260926120000_config_from_env/migration.sql`:

```sql
-- Configuration moved to environment variables (see
-- docs/superpowers/specs/2026-09-26-env-config-design.md). Run this only after
-- the new server is deployed: the old server reads both of these at boot.

-- DropTable
DROP TABLE "SystemSetting";

-- AlterTable
ALTER TABLE "StorageProvider" DROP COLUMN "configCipher",
DROP COLUMN "keyVersion";
```

Check `prisma/migrations/20260915150030_add_catalog_core/migration.sql` that the table is created as `"SystemSetting"` and the columns as `"configCipher"`/`"keyVersion"`; match its exact quoting.

- [ ] **Step 5: Seed without crypto**

`prisma/seed.ts`:

```ts
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

loadEnv({ path: resolve(process.cwd(), '.env') });

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../src/generated/prisma/client';

/**
 * Creates the default Cloudinary provider row if none exists. The row is only
 * the identity asset files point at — credentials come from CLOUDINARY_* in
 * the environment and are never stored in the database.
 */
async function main(): Promise<void> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  });

  const existing = await prisma.storageProvider.findFirst({ where: { isDefault: true } });
  if (existing) {
    console.log('Default storage provider already present — nothing to seed.');
  } else {
    await prisma.storageProvider.create({
      data: {
        kind: 'cloudinary',
        name: 'Primary Cloudinary',
        isDefault: true,
        isActive: true,
        publicConfig: { folder: process.env.CLOUDINARY_AUDIO_FOLDER ?? 'slimshot/audio' },
      },
    });
    console.log('Seeded default Cloudinary storage provider.');
  }
  await prisma.$disconnect();
}

void main();
```

- [ ] **Step 6: Env files**

`.env.example`: delete the `MASTER_ENCRYPTION_KEY` block (comment and variable). `test/setup-env.ts`: delete the `MASTER_ENCRYPTION_KEY` line and its comment reference.

- [ ] **Step 7: Verify the new server never touches the dropped data**

Run:
```bash
grep -rn "systemSetting\|configCipher\|keyVersion" src prisma/seed.ts --include=*.ts | grep -v "src/generated"
```
Expected: no output.

- [ ] **Step 8: Gates and commit**

Run the server gates. Expected: all pass; test count drops by the deleted specs only.

```bash
git add -A src prisma eslint.config.mjs .env.example test/setup-env.ts
git commit -m "refactor: remove the database settings system, secret reveal and crypto

Configuration now comes only from the environment. The SystemSetting table,
the settings endpoints, the elevation-grant reveal flow, the settings
permissions and the envelope crypto (and MASTER_ENCRYPTION_KEY) are gone.
The migration drops the table and the StorageProvider credential columns; run
it only after this server is deployed.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Dashboard — remove Settings, four-tab navigation, phone top bar

**Repo:** `slimshot-admin`.

**Files:**
- Delete: `app/(dashboard)/settings/page.tsx`, `page.test.tsx`, `components/settings/` (all), `lib/api/settings.ts`, `lib/use-idle-timer.ts`, `lib/use-idle-timer.test.ts`, `lib/auth/profile.ts`
- Modify: `components/shell/nav-items.ts`, `components/shell/sidebar.tsx`, `components/shell/app-shell.tsx`, `components/shell/app-shell.test.tsx`, `components/shell/logout-button.tsx`
- Create: `components/shell/mobile-top-bar.tsx`
- Modify: `README.md`, `docs/api-reference.md`, `docs/START-HERE.md`, `lib/upload/queue.ts` (comment only)

**Interfaces:**
- Consumes: `performLogout()` from `components/shell/logout-button.tsx`.
- Produces: `NAV_ITEMS` = Overview, Assets, Categories, Audit log (used by both navs); `<MobileTopBar />`.

- [ ] **Step 1: Update the shell tests first** (`components/shell/app-shell.test.tsx`)

Replace the audit test and add:

```ts
  it('offers the same four destinations on both navs, with no Settings', () => {
    render(<AppShell><p>content</p></AppShell>);
    for (const nav of [screen.getByTestId('sidebar'), screen.getByTestId('bottom-nav')]) {
      const hrefs = [...nav.querySelectorAll('a')].map((a) => a.getAttribute('href'));
      expect(hrefs).toEqual(['/', '/assets', '/categories', '/audit']);
    }
    expect(document.querySelector('a[href="/settings"]')).toBeNull();
  });

  it('puts a log out button in a phone-only top bar', () => {
    render(<AppShell><p>content</p></AppShell>);
    const bar = screen.getByTestId('mobile-top-bar');
    expect(bar).toHaveClass('md:hidden');
    expect(within(bar).getByRole('button', { name: /log out/i })).toBeInTheDocument();
  });
```

Import `within` from `@testing-library/react`. Keep "renders exactly four navigation peers" (`NAV_ITEMS` length 4).

Run: `npx vitest run components/shell` — Expected: FAIL.

- [ ] **Step 2: Implement**

`nav-items.ts`:

```ts
import { FolderTree, LayoutDashboard, Music, ScrollText, type LucideIcon } from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

// Four peers on both the phone bottom bar and the desktop sidebar. There is
// no Settings page: server configuration lives in the server's .env.
export const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/assets', label: 'Assets', icon: Music },
  { href: '/categories', label: 'Categories', icon: FolderTree },
  { href: '/audit', label: 'Audit log', icon: ScrollText },
];
```

`sidebar.tsx`: import `NAV_ITEMS` instead of `SIDEBAR_ITEMS` and map over it.

`components/shell/mobile-top-bar.tsx`:

```tsx
'use client';

import { LogOut } from 'lucide-react';
import { performLogout } from './logout-button';

const GRADIENT = 'bg-[linear-gradient(135deg,var(--brand-from)_0%,var(--brand-to)_100%)]';

/** Phones only: logo and Log out. The bottom bar holds navigation. */
export function MobileTopBar() {
  return (
    <header
      data-testid="mobile-top-bar"
      className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-border bg-surface px-4 md:hidden"
    >
      <div className="flex items-center gap-2">
        <div className={`h-7 w-7 rounded-lg ${GRADIENT}`} />
        <span className="font-semibold">SlimShot</span>
      </div>
      <button
        type="button"
        onClick={performLogout}
        aria-label="Log out"
        className="flex h-11 w-11 items-center justify-center rounded-lg text-muted transition-colors duration-150 ease-out hover:bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-from)]"
      >
        <LogOut size={20} />
      </button>
    </header>
  );
}
```

`app-shell.tsx`:

```tsx
import type { ReactNode } from 'react';
import { BottomNav } from './bottom-nav';
import { MobileTopBar } from './mobile-top-bar';
import { Sidebar } from './sidebar';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileTopBar />
        {/* pb-20 clears the fixed bottom nav on phones; md:pb-8 drops it. */}
        <main className="flex-1 px-4 pb-20 pt-6 md:px-8 md:pb-8">{children}</main>
      </div>
      <BottomNav />
    </div>
  );
}
```

`logout-button.tsx`: update the doc comment's last sentence to "The sidebar and the phone top bar call performLogout rather than each calling logout() themselves." Remove the `LogoutButton` export only if nothing imports it any more (check with `grep -rn LogoutButton app components`).

Delete every file listed under Delete. Run `grep -rn "components/settings\|lib/api/settings\|use-idle-timer\|lib/auth/profile\|/settings" app components lib` — expected: no hits except test assertions that `/settings` is absent.

`lib/upload/queue.ts`: change any comment mentioning the `upload.audio.mimeTypes` setting to "the server's UPLOAD_AUDIO_MIME_TYPES".

Docs: in `README.md` remove the Settings/owner paragraph and mention that server configuration is the server's `.env` (link `slimshot_server/.env.example`); in `docs/api-reference.md` delete the `/settings` section and the "Reveal flow" section and add one line: "Settings endpoints were removed on 2026-09-26; configuration lives in the server's .env."; in `docs/START-HERE.md` remove the owner/Settings sentence.

- [ ] **Step 3: Run and watch it pass; gates; commit**

Run: `npx vitest run components/shell`, then the dashboard gates. Expected: all pass.

```bash
git add -A app components lib README.md docs
git commit -m "feat: drop the Settings page; four-tab nav with a phone top bar

Server configuration moved to the server's .env, so the dashboard no longer
edits settings. Audit joins the phone bottom bar, and Log out moves to a
phone-only top bar.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After all tasks

Final whole-branch review of both branches, then hand back to the owner with the rollout order from the spec §7: add new variables to `.env` (see `.env.example`), deploy the server, then `npx prisma migrate deploy`, then the dashboard.
