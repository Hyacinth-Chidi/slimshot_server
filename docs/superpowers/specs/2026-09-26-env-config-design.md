# Configuration from the environment — design

**Date:** 2026-09-26
**Status:** Approved in conversation; awaiting review of this written spec
**Repos:** `slimshot_server` (API) and `slimshot-admin` (dashboard)

## 1. Purpose

All server configuration comes from environment variables (`.env`), loaded and
validated the standard NestJS way. The database holds no configuration.

The current design stores configuration in a `SystemSetting` table (upload
limits, login lockout, CORS origins, Redis URL, and until yesterday the JWT
secret and token lifetimes), edited at runtime from the dashboard's Settings
page, and stores Cloudinary credentials encrypted in `StorageProvider`. The
owner considers that a poor design: configuration is deployment config and
belongs in the environment.

Future exception, not built here: third-party API keys (for example an AI
provider's) will be stored in the database. That feature brings its own
encryption back when it is built.

## 2. Decisions (made with the owner)

| Question | Decision |
|---|---|
| How to load config | Standard `@nestjs/config`: `ConfigModule.forRoot({ validate })` with a class-validator schema, plus namespaced `registerAs()` configs injected as `ConfigType<typeof x>` |
| Cloudinary credentials | `.env`, like everything else |
| Dashboard Settings page | Removed |
| Phone navigation | Bottom bar: Overview, Assets, Categories, Audit. A slim top bar on phones holds the logo and Log out |
| `SystemSetting` table | Dropped by a Prisma migration the owner runs |
| `MASTER_ENCRYPTION_KEY` | Dropped with the crypto module; nothing encrypted remains in the database |
| Changing a value | Edit `.env`, restart the server. No runtime editing |

## 3. Environment variables

Validated once at boot by `src/config/env.validation.ts`. Any missing required
variable or out-of-range value stops the server with a message naming it.

| Namespace (`registerAs`) | Variable | Required / default | Validation |
|---|---|---|---|
| `app` | `NODE_ENV` | `development` | one of development, production, test |
| | `PORT` | `2700` | 1–65535 |
| | `ADMIN_BASE_URL` | optional | URL (scheme + host + port, trailing `/` stripped) |
| | `CORS_ALLOWED_ORIGINS` | optional, empty | comma-separated URLs |
| `database` | `DATABASE_URL` | required | non-empty |
| `redis` | `REDIS_URL` | required | non-empty, `redis://` or `rediss://` |
| `auth` | `JWT_ACCESS_SECRET` | required | ≥ 32 characters |
| | `JWT_ACCESS_TTL_SECONDS` | `900` | 60–3600 |
| | `JWT_REFRESH_TTL_SECONDS` | `604800` | 3600–7776000 |
| | `AUTH_LOGIN_MAX_ATTEMPTS` | `5` | 1–100 |
| | `AUTH_LOGIN_LOCKOUT_SECONDS` | `900` | 30–86400 |
| | `ADMIN_BOOTSTRAP_EMAIL` | optional | email |
| | `ADMIN_BOOTSTRAP_PASSWORD` | optional | non-empty when the email is set |
| `upload` | `UPLOAD_AUDIO_MAX_BYTES` | `52428800` | 1–1073741824 |
| | `UPLOAD_AUDIO_MIME_TYPES` | `audio/mpeg,audio/wav,audio/aac,audio/ogg,audio/flac` | comma-separated, non-empty |
| | `UPLOAD_TICKET_TTL_SECONDS` | `900` | 60–86400 |
| `cloudinary` | `CLOUDINARY_CLOUD_NAME` | required | non-empty |
| | `CLOUDINARY_API_KEY` | required | non-empty |
| | `CLOUDINARY_API_SECRET` | required | non-empty |
| | `CLOUDINARY_AUDIO_FOLDER` | `slimshot/audio` | non-empty |

Ranges are the ones the removed setting definitions enforced, so behaviour is
unchanged. Empty strings count as unset (a `.env` line with no value arrives as
`''`). `.env.example` documents every variable.

CORS: the allowed origins are `CORS_ALLOWED_ORIGINS` plus `ADMIN_BASE_URL`,
de-duplicated. If both are empty, CORS stays open (today's behaviour for an
empty setting).

## 4. Server design

### 4.1 Config module (new)

`src/config/`:

- `env.validation.ts` — one `EnvironmentVariables` class (class-validator
  decorators, `enableImplicitConversion`) and `validate(config)` that throws on
  any error. Passed to `ConfigModule.forRoot({ isGlobal: true, validate })` in
  `AppModule`, replacing today's `envFilePath`-only setup.
- `app.config.ts`, `database.config.ts`, `redis.config.ts`, `auth.config.ts`,
  `upload.config.ts`, `cloudinary.config.ts` — each a `registerAs` factory that
  shapes validated env into a typed object (for example comma lists become
  `string[]`, `ADMIN_BASE_URL` loses its trailing slash). Loaded with
  `forRoot({ load: [...] })`.
- Consumers inject `@Inject(authConfig.KEY) config: ConfigType<typeof authConfig>`.
  `main.ts` reads config through `app.get(appConfig.KEY)`.

`src/modules/auth/jwt-config.ts` (added yesterday) is folded into
`auth.config.ts` and deleted; its tests move to the validation tests.

### 4.2 Consumers switched to injected config

| File | Today | After |
|---|---|---|
| `src/main.ts` | `settings.get('cors.allowedOrigins')`, `process.env.PORT/ADMIN_BASE_URL` | `appConfig` |
| `src/core/cache/redis.module.ts` | `settings.get('redis.url')` | `redisConfig` |
| `src/core/queue/queue.module.ts` | `settings.get('redis.url')` | `redisConfig` |
| `src/modules/auth/token.service.ts` | `JWT_CONFIG` token | `authConfig` |
| `src/modules/auth/login-attempt.service.ts` | `auth.loginMaxAttempts`, `auth.loginLockoutSeconds` settings | `authConfig` |
| `src/modules/auth/auth.service.ts` | bootstrap env reads, `auth.bootstrapCompleted` setting | `authConfig`; flag removed |
| `src/modules/ingest/ingest.service.ts` | three `upload.*` settings | `uploadConfig` |
| `src/modules/assets/kind-registry.ts` | comment points at SettingsService | comment updated |
| `src/core/storage/storage.registry.ts` | decrypts `configCipher` per provider row | builds the Cloudinary adapter from `cloudinaryConfig` |
| `src/prisma/prisma.service.ts` | `process.env.DATABASE_URL` | `databaseConfig` |

### 4.3 Removed

- Settings system: `src/core/settings/` (service, module, registry,
  definitions, specs), `src/modules/admin/admin-settings.controller.ts`,
  `settings-admin.service.ts` and spec, their DTOs, and their registration in
  `admin.module.ts` / `app.module.ts`. The `/api/admin/v1/settings*` routes
  disappear.
- Elevation grants (only settings reveal/write used them):
  `src/core/auth/elevation.*`, the `revokeForAdmin` calls in `auth.service.ts`
  (logout) and `token.service.ts` (deactivation). Refresh-token family
  revocation on logout and deactivation is unchanged.
- The settings-reveal lockout and audit paths in `login-attempt.service.ts`
  (`settings.reveal.*` actions); login lockout itself stays.
- `auth.bootstrapCompleted`: bootstrap already runs only when no admin exists.
- Crypto: `src/core/crypto/` and `MASTER_ENCRYPTION_KEY`. The key's entry in the
  ESLint env allow-list goes too.
- `ErrorCode.SETTING_INVALID` (defined but never used).

### 4.4 ESLint env rule

The `no-restricted-properties` rule on `process.env` stays: config is read only
in `src/config/**`, `prisma.config.ts`, `prisma/seed.ts` and tests. Every other
file reads config by injection. The allow-list is rewritten to match.

### 4.5 Storage

`StorageProvider` rows remain the identity that `AssetFile` rows reference
(`kind`, `name`, `isDefault`, `isActive`). They stop holding credentials. The
registry keeps its lookups (`default provider`, `provider by id`) and builds
each Cloudinary adapter from `cloudinaryConfig`. Only one Cloudinary account is
supported (there is only one today).

### 4.6 Error handling

A misconfiguration is a boot failure, never a request-time 500. The validation
error lists every failing variable at once, not just the first.

## 5. Database

One Prisma migration:

- `DROP TABLE "SystemSetting"`.
- `ALTER TABLE "StorageProvider" DROP COLUMN "configCipher", DROP COLUMN "keyVersion"`.

`prisma/seed.ts` creates (or leaves) the default Cloudinary provider row with
no credentials, and no longer needs `MASTER_ENCRYPTION_KEY`.

The migration only runs when the owner runs `npx prisma migrate deploy`. The
rows it deletes (old JWT secret, Redis URL, limits, encrypted Cloudinary
config) are not needed afterwards.

## 6. Dashboard design (`slimshot-admin`)

- Remove the Settings route and everything only it used: `app/(dashboard)/settings/`,
  `components/settings/`, `lib/api/settings.ts`, `lib/use-idle-timer.ts`,
  `lib/auth/profile.ts` (only the Settings page and secret field use it), and
  their tests.
  `lib/api/field-errors.ts` stays (categories use it).
- Navigation: `NAV_ITEMS` (phone bottom bar) becomes Overview, Assets,
  Categories, Audit. The desktop sidebar shows the same four plus Log out,
  keeping collapse. `SIDEBAR_ITEMS` merges back into `NAV_ITEMS`.
- A phone-only top bar (`md:hidden`): logo mark and a Log out icon button with
  an accessible name, 44px target.
- The `/audit` page's link from the Overview stays.
- README and `docs/api-reference.md` drop the Settings sections and the owner
  requirement that only Settings needed.

## 7. Rollout order

1. Add the new variables to the server's `.env` (see `.env.example`).
2. Deploy the new server code and restart it.
3. Run `npx prisma migrate deploy` (drops the table and columns).
4. Deploy the new dashboard.

The old server reads `SystemSetting` at boot, so running the migration before
step 2 would crash it. The new server does not touch the dropped table or
columns, so it works before and after the migration.

## 8. Testing

- `env.validation.spec.ts`: accepts a complete valid env; applies each default;
  rejects each required variable when missing or empty; rejects each
  out-of-range number; reports several failures in one error; parses comma
  lists and strips the `ADMIN_BASE_URL` trailing slash.
- Existing specs for token, login-attempt, auth, ingest, storage registry,
  redis/queue modules are updated to construct config objects instead of
  mocking `SettingsService`. Removed code's specs are deleted with it.
- Dashboard: shell tests assert the four tabs, the Audit entry, the phone top
  bar's Log out, and that no `/settings` link exists anywhere.
- Gates: server `tsc`, `eslint src test`, `jest`; dashboard `vitest`, lint,
  `tsc`, `next build`.

## 9. Out of scope

- Storing AI or other third-party API keys in the database (future feature;
  brings encryption back then).
- Multiple Cloudinary accounts.
- Any change to asset, category, audit or auth behaviour beyond where their
  configuration comes from.
