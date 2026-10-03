# Accounts and Credits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** App-user accounts (Google or emailed code), a credit ledger that can never overdraw, admin-set pricing for Auto captions, a signup bonus, referrals, AdMob rewarded ads, account deletion, and the admin API to run it all.

**Architecture:** New `accounts`, `credits` and `rewards` modules beside the existing ones. `LedgerService` is the only writer of `CreditTransaction` and `User.creditBalance`: one guarded `UPDATE … WHERE creditBalance >= n` plus an insert keyed by a unique idempotency key, inside one transaction. Business settings and pricing live in the database (admin-edited); secrets live in `.env`.

**Tech Stack:** NestJS 11, Prisma 7.8 (`@prisma/adapter-pg`), Redis (ioredis) for codes and counters, BullMQ (captions), `google-auth-library` 11, `nodemailer` 10, Node `crypto` (HMAC, ECDSA), Jest 30.

**Spec:** `docs/superpowers/specs/2026-10-03-accounts-and-credits-design.md` (read it first; this plan argues from it).

## Global Constraints

- Every commit ends with exactly one trailer line: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never `git stash`, never `--no-verify`. Work on branch `feat/accounts-credits` (already created; the spec is committed there). Do not push or merge.
- Never run `prisma migrate dev|deploy`, `db push` or anything against `DATABASE_URL`. The migration is assembled offline with `prisma migrate diff --from-schema … --to-schema …`; the owner deploys it.
- Never print `.env` values. Only provider API keys live in the database; all other secrets live in `.env`, read through a `src/config` namespace (ESLint forbids `process.env` elsewhere).
- No Android ID anywhere. The per-device anti-abuse key is the install (`Device.id`).
- Credits are integers. Only `LedgerService` writes `CreditTransaction` or `User.creditBalance`.
- Envelope: `{ "success": true, "data": … }` / `{ "success": false, "error": { code, message, details?, traceId } }`. App errors are thrown with `appError(status, code, message, details?)` (Task 3).
- App routes live under `/api/app/v1`, admin routes under `/api/admin/v1`, the deletion page at `/account-deletion`.
- Tests use mocks and in-memory fakes (`test/fakes/`). Nothing touches Neon, Redis, Google, AdMob or SMTP.
- Write generated files with bash redirection, never PowerShell `Out-File` (it adds a BOM). Use `git -C <repo>` or absolute paths.
- Checks: `npx jest <paths>`, `npm run lint`, `npm run typecheck`, `npm run build`.
- **Speed (owner's request):** documentation tasks give the exact content outline (every endpoint, field and error code); the executor writes the prose from it. Code steps carry full code.

## Review Focus

1. **Two sign-ins racing to create the same new account** (a double tap): one account, both requests get tokens, nobody sees a 500. Pinned in Task 9.
2. **A WAV with extra chunks (`LIST`, `JUNK`) or odd-sized padding before `data`, or a streaming header with a placeholder size**: the duration is still right. Pinned in Task 14.
3. **AdMob's console "test" callback** (no `custom_data`, no `user_id`): `200`, nothing granted, no crash. Pinned in Task 20.
4. **A username typed with capitals or spaces (`"  Ann_1 "`)**: stored and checked as `ann_1`. Pinned in Task 7.
5. **A caption job that fails after its owner deleted the account**: the refund is refused (account gone), logged and audited, and the worker still finishes the job cleanly. Pinned in Task 15.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/config/env.validation.ts`, `app-auth.config.ts`, `email.config.ts`, `admob.config.ts` | new `.env` rules and namespaces |
| `prisma/schema.prisma`, `prisma/migrations/20261003120000_accounts_and_credits/` | all new tables, CHECK, partial index, settings row |
| `src/core/errors/app-error.ts` | `appError()` helper; filter passes `details` |
| `src/core/identity/` | `IdentityHashService` (HMAC), email normalisation, `IdentityModule` (global) |
| `src/core/rate-limit/rate-limiter.ts` | Redis fixed-window counters |
| `src/modules/credits/credit-settings.*` | the one settings row, cached |
| `src/modules/credits/ledger.*` | the only writer of balances |
| `src/modules/credits/ad-allowance.ts` | UTC day helpers, ads used today |
| `src/modules/credits/pricing.service.ts`, `credits.service.ts`, `credits.controller.ts`, `reconciliation.service.ts`, `credits.module.ts` | pricing, quote, history, balance check |
| `src/modules/accounts/` | sign-in (Google, email code), tokens, guard, `/me`, username, claim (bonus + referral), deletion, deletion page |
| `src/modules/captions/wav.ts`, `caption-refunds.ts` (+ changed service, worker, controller) | paid WAV captions |
| `src/modules/rewards/` | AdMob verification, ad sessions, callback, poll |
| `src/modules/admin/admin-credit-*.controller.ts`, `admin-users.*` | admin API |
| `test/fakes/fake-redis.ts`, `test/fakes/fake-credit-db.ts` | in-memory Redis and ledger database for tests |
| `docs/app-credits-api.md` | the app contract |

---

# Milestone 1 — Accounts

### Task 0: Commit the plan

- [ ] **Step 1: Commit**

```bash
cd "C:/Users/HP/Desktop/Slimshot workspace/slimshot_server"
git add docs/superpowers/plans/2026-10-03-accounts-and-credits.md
git commit -m "docs: accounts and credits implementation plan

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1: Configuration

**Files:**
- Modify: `src/config/env.validation.ts` (imports, helpers, new fields after `CAPTION_ELEVENLABS_MODEL`, `parseEnv`)
- Create: `src/config/app-auth.config.ts`, `src/config/email.config.ts`, `src/config/admob.config.ts`
- Modify: `src/config/app.config.ts`, `src/config/index.ts`, `src/app.module.ts` (load list), `src/main.ts`, `test/setup-env.ts`, `.env.example`
- Test: `src/config/env.validation.spec.ts`

**Interfaces:**
- Produces: `appAuthConfig` / `AppAuthConfig` = `{ jwtSecret: string; accessTtlSeconds: number; refreshTtlSeconds: number; identityHmacSecret: string; googleClientIds: string[] }`; `emailConfig` / `EmailConfig` = `{ sender: 'log'|'smtp'; from: string; smtp: { host: string; port: number; secure: boolean; user?: string; password?: string } }`; `admobConfig` / `AdmobConfig` = `{ adUnitIds: string[]; verifierKeysUrl: string }`; `AppConfig.trustProxy: boolean | number`.

- [ ] **Step 1: Write the failing tests**

In `src/config/env.validation.spec.ts`:

1. Add imports:

```ts
import { admobConfig } from './admob.config';
import { appAuthConfig } from './app-auth.config';
import { emailConfig } from './email.config';
```

2. Add to `BASE`:

```ts
  USER_JWT_SECRET: 'u'.repeat(48),
  IDENTITY_HMAC_SECRET: 'i'.repeat(48),
```

3. Add `'USER_JWT_SECRET',` and `'IDENTITY_HMAC_SECRET',` to the `rejects a missing or empty %s` list, and these rows to `rejects %s=%s`:

```ts
    ['USER_ACCESS_TTL_SECONDS', '30'],
    ['USER_REFRESH_TTL_SECONDS', '60'],
    ['EMAIL_SENDER', 'pigeon'],
```

4. Add inside `describe('parseEnv', …)`:

```ts
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
```

5. Add inside `describe('config namespaces', …)`:

```ts
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx jest src/config/env.validation.spec.ts`
Expected: FAIL — `./admob.config`, `./app-auth.config`, `./email.config` cannot be found.

- [ ] **Step 3: Implement the variables**

In `src/config/env.validation.ts`, add `IsBoolean,` to the `class-validator` import. Below `const DEFAULT_CAPTION_TMP_DIR = …;` add:

```ts
const DEFAULT_ADMOB_KEYS_URL = 'https://www.gstatic.com/admob/reward/verifier-keys.json';

const bool =
  (fallback: boolean) =>
  ({ value }: TransformFnParams): unknown => {
    if (blank(value)) return fallback;
    const s = String(value).trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
    return s;
  };

// Express accepts true/false or a hop count; anything else is a typo.
const trustProxy = ({ value }: TransformFnParams): unknown => {
  if (blank(value)) return false;
  const s = String(value).trim().toLowerCase();
  if (s === 'true') return true;
  if (s === 'false') return false;
  return /^\d+$/.test(s) ? Number(s) : s;
};
```

Inside `class Env`, after `CAPTION_ELEVENLABS_MODEL = 'scribe_v2';`, add:

```ts

  // App-user tokens: a secret of their own, never the admin one.
  @Transform(text)
  @IsDefined({ message: 'USER_JWT_SECRET is required' })
  @IsString()
  @MinLength(32, { message: 'USER_JWT_SECRET must be at least 32 characters' })
  USER_JWT_SECRET!: string;

  @Transform(int(900))
  @IsInt()
  @Min(60)
  @Max(3_600)
  USER_ACCESS_TTL_SECONDS = 900;

  @Transform(int(2_592_000))
  @IsInt()
  @Min(86_400)
  @Max(7_776_000)
  USER_REFRESH_TTL_SECONDS = 2_592_000;

  // Keys every stored email, install and IP hash. Changing it forgets who
  // already claimed a bonus.
  @Transform(text)
  @IsDefined({ message: 'IDENTITY_HMAC_SECRET is required' })
  @IsString()
  @MinLength(32, { message: 'IDENTITY_HMAC_SECRET must be at least 32 characters' })
  IDENTITY_HMAC_SECRET!: string;

  @Transform(list([]))
  @IsArray()
  @IsString({ each: true })
  GOOGLE_CLIENT_IDS: string[] = [];

  @Transform(({ value }) => (blank(value) ? 'log' : String(value).trim().toLowerCase()))
  @IsIn(['log', 'smtp'])
  EMAIL_SENDER: 'log' | 'smtp' = 'log';

  @Transform(text)
  @IsOptional()
  @IsString()
  SMTP_HOST?: string;

  @Transform(int(587))
  @IsInt()
  @Min(1)
  @Max(65_535)
  SMTP_PORT = 587;

  @Transform(bool(false))
  @IsBoolean()
  SMTP_SECURE = false;

  @Transform(text)
  @IsOptional()
  @IsString()
  SMTP_USER?: string;

  @Transform(text)
  @IsOptional()
  @IsString()
  SMTP_PASSWORD?: string;

  @Transform(text)
  @IsOptional()
  @IsString()
  EMAIL_FROM?: string;

  @Transform(list([]))
  @IsArray()
  @IsString({ each: true })
  ADMOB_AD_UNIT_IDS: string[] = [];

  @Transform(({ value }) => (blank(value) ? DEFAULT_ADMOB_KEYS_URL : String(value).trim()))
  @IsUrl({ require_tld: false, require_protocol: true, protocols: ['http', 'https'] })
  ADMOB_VERIFIER_KEYS_URL = DEFAULT_ADMOB_KEYS_URL;

  // Checked in crossFieldProblems: a boolean or a hop count.
  @Transform(trustProxy)
  TRUST_PROXY: boolean | number = false;
```

Below `problemsOf`, add:

```ts
/** Rules that span variables, which decorators cannot express. */
function crossFieldProblems(env: Env): string[] {
  const problems: string[] = [];
  if (env.USER_JWT_SECRET && env.USER_JWT_SECRET === env.JWT_ACCESS_SECRET) {
    problems.push('USER_JWT_SECRET must differ from JWT_ACCESS_SECRET');
  }
  if (env.EMAIL_SENDER === 'smtp') {
    if (!env.SMTP_HOST) problems.push('SMTP_HOST is required when EMAIL_SENDER=smtp');
    if (!env.EMAIL_FROM) problems.push('EMAIL_FROM is required when EMAIL_SENDER=smtp');
  }
  if (env.NODE_ENV === 'production') {
    if (env.EMAIL_SENDER === 'log') {
      problems.push('EMAIL_SENDER=log prints sign-in codes in the log; use smtp in production');
    }
    if (env.ADMOB_AD_UNIT_IDS.length === 0) {
      problems.push('ADMOB_AD_UNIT_IDS is required in production');
    }
  }
  const tp: unknown = env.TRUST_PROXY;
  if (!(typeof tp === 'boolean' || (Number.isInteger(tp) && (tp as number) >= 0 && (tp as number) <= 10))) {
    problems.push('TRUST_PROXY must be true, false or a hop count from 0 to 10');
  }
  return problems;
}
```

In `parseEnv`, replace the `const problems = …` line with:

```ts
  const problems = [
    ...problemsOf(validateSync(env, { skipMissingProperties: false })),
    ...crossFieldProblems(env),
  ];
```

- [ ] **Step 4: Create the namespaces**

`src/config/app-auth.config.ts`:

```ts
import { ConfigType, registerAs } from '@nestjs/config';

import { parseEnv } from './env.validation';

export const appAuthConfig = registerAs('appAuth', () => {
  const env = parseEnv(process.env);
  return {
    jwtSecret: env.USER_JWT_SECRET,
    accessTtlSeconds: env.USER_ACCESS_TTL_SECONDS,
    refreshTtlSeconds: env.USER_REFRESH_TTL_SECONDS,
    identityHmacSecret: env.IDENTITY_HMAC_SECRET,
    googleClientIds: env.GOOGLE_CLIENT_IDS,
  };
});

export type AppAuthConfig = ConfigType<typeof appAuthConfig>;
```

`src/config/email.config.ts`:

```ts
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
```

`src/config/admob.config.ts`:

```ts
import { ConfigType, registerAs } from '@nestjs/config';

import { parseEnv } from './env.validation';

export const admobConfig = registerAs('admob', () => {
  const env = parseEnv(process.env);
  return { adUnitIds: env.ADMOB_AD_UNIT_IDS, verifierKeysUrl: env.ADMOB_VERIFIER_KEYS_URL };
});

export type AdmobConfig = ConfigType<typeof admobConfig>;
```

In `src/config/app.config.ts`, change the return to:

```ts
  return { nodeEnv: env.NODE_ENV, port: env.PORT, corsOrigins, trustProxy: env.TRUST_PROXY };
```

In `src/config/index.ts` add (alphabetical):

```ts
export { admobConfig, type AdmobConfig } from './admob.config';
export { appAuthConfig, type AppAuthConfig } from './app-auth.config';
export { emailConfig, type EmailConfig } from './email.config';
```

In `src/app.module.ts`, import `admobConfig`, `appAuthConfig`, `emailConfig` from `./config` and append them to the `load` array after `captionConfig`.

In `src/main.ts`: add `import type { NestExpressApplication } from '@nestjs/platform-express';`, change the create line to `const app = await NestFactory.create<NestExpressApplication>(AppModule);`, and after `app.enableShutdownHooks();` add:

```ts
  // Behind nginx every request comes from the proxy; this makes req.ip the client.
  app.set('trust proxy', config.trustProxy);
```

Append to `test/setup-env.ts`:

```ts
process.env.USER_JWT_SECRET = process.env.USER_JWT_SECRET ?? 'u'.repeat(48);
process.env.IDENTITY_HMAC_SECRET = process.env.IDENTITY_HMAC_SECRET ?? 'i'.repeat(48);
```

Append to `.env.example`, before `# One-time bootstrap`:

```bash
# App user accounts (sign-in for the mobile app). Its own secret: at least 32
# characters and different from JWT_ACCESS_SECRET.
USER_JWT_SECRET=replace_with_at_least_32_random_characters
USER_ACCESS_TTL_SECONDS=900
USER_REFRESH_TTL_SECONDS=2592000
# Hashes emails, installs, IPs and sign-in codes (at least 32 characters).
# Never change it once users exist: bonus history is keyed by it.
IDENTITY_HMAC_SECRET=replace_with_at_least_32_random_characters
# Google sign-in: the OAuth *Web* client ID the app passes as its server client
# ID, comma-separated if more than one. Empty disables Google sign-in.
GOOGLE_CLIENT_IDS=
# Sign-in codes: "log" prints them in the server log (development only);
# "smtp" emails them. Production refuses "log".
EMAIL_SENDER=log
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASSWORD=
EMAIL_FROM="SlimShot <no-reply@example.com>"
# Rewarded ads: your AdMob rewarded ad unit IDs, comma-separated (required in
# production). Verification callbacks from any other ad unit are ignored.
ADMOB_AD_UNIT_IDS=
# Behind a reverse proxy (nginx) set this to 1 so per-IP limits see the real
# client address. Leave false when the server faces the internet directly.
TRUST_PROXY=false

```

- [ ] **Step 5: Run the tests, lint and typecheck**

Run: `npx jest src/config && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config src/app.module.ts src/main.ts test/setup-env.ts .env.example
git commit -m "feat: config for app accounts, email, AdMob and proxy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Database schema and migration

**Files:**
- Modify: `prisma/schema.prisma` (replace `model User` and `model Device`; append new enums and models)
- Create: `prisma/migrations/20261003120000_accounts_and_credits/migration.sql`
- Regenerate: `src/generated/prisma/**`
- Test: `src/prisma/credits-schema.spec.ts`

**Interfaces:**
- Produces: enums `CreditTxType`, `CreditFeature`, `PricingMode`, `BonusClaimKind`, `ReferralOutcome` in `src/generated/prisma/enums`; delegates `prisma.userSession`, `userRefreshToken`, `creditTransaction`, `bonusClaim`, `referral`, `creditSettings`, `pricingRule`; `User` fields `googleSub, username, referralCode, creditBalance, claimedAt, signupIpLimited`; `Device.userId`. Model types via `import type { CreditSettings, CreditTransaction, PricingRule, Prisma } from '../../generated/prisma/client'`.

- [ ] **Step 1: Write the failing test**

`src/prisma/credits-schema.spec.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CreditTxType } from '../generated/prisma/enums';

const sql = readFileSync(
  join(__dirname, '../../prisma/migrations/20261003120000_accounts_and_credits/migration.sql'),
  'utf8',
);

describe('accounts and credits schema', () => {
  it('knows every ledger type', () => {
    expect(Object.values(CreditTxType)).toEqual([
      'signup_bonus',
      'referral_inviter',
      'referral_invitee',
      'rewarded_ad',
      'feature_charge',
      'feature_refund',
      'admin_adjustment',
      'account_deleted',
      'purchase',
    ]);
  });

  // Prisma's schema language cannot express these three; they live only in
  // the hand-finished migration, so regenerating it would silently drop them.
  it('stops a balance going below zero at the database', () => {
    expect(sql).toContain(
      'ALTER TABLE "User" ADD CONSTRAINT "User_creditBalance_nonnegative" CHECK ("creditBalance" >= 0);',
    );
  });

  it('allows one active pricing rule per feature', () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "PricingRule_one_active" ON "PricingRule"("feature") WHERE "isActive";',
    );
  });

  it('creates the default settings row', () => {
    expect(sql).toMatch(/INSERT INTO "CreditSettings"[\s\S]*'default', 100, 5, 10, 20, 20, 10, 30, 10,/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx jest src/prisma/credits-schema.spec.ts`
Expected: FAIL — `CreditTxType` is not exported / the migration file does not exist.

- [ ] **Step 3: Save the current schema and edit it**

```bash
cd "C:/Users/HP/Desktop/Slimshot workspace/slimshot_server"
SCRATCH="C:/Users/HP/AppData/Local/Temp/claude/c--Users-HP-Desktop-Slimshot-workspace/619feb03-2d15-43b9-b229-470228db81c5/scratchpad"
git show HEAD:prisma/schema.prisma > "$SCRATCH/schema-before-credits.prisma"
```

Replace `model User { … }` with:

```prisma
model User {
  id              String        @id @default(cuid())
  email           String?       @unique
  phone           String?       @unique
  displayName     String?
  avatarUrl       String?
  accountStatus   AccountStatus @default(active)
  tier            String        @default("free")
  googleSub       String?       @unique
  username        String?       @unique
  referralCode    String?       @unique
  creditBalance   Int           @default(0)
  claimedAt       DateTime?
  signupIpLimited Boolean       @default(false)
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt
  deletedAt       DateTime?

  entitlements     UserEntitlement[]
  assets           Asset[]
  sessions         UserSession[]
  devices          Device[]
  ledger           CreditTransaction[]
  referralsMade    Referral[]          @relation("ReferralInviter")
  referralReceived Referral?           @relation("ReferralInvitee")
}
```

Replace `model Device { … }` with:

```prisma
model Device {
  id         String   @id @default(cuid())
  tokenHash  String   @unique
  platform   String?
  appVersion String?
  userId     String?
  createdAt  DateTime @default(now())
  lastSeenAt DateTime @default(now())

  user     User?         @relation(fields: [userId], references: [id], onDelete: SetNull)
  sessions UserSession[]

  @@index([userId])
}
```

Append:

```prisma

enum CreditTxType {
  signup_bonus
  referral_inviter
  referral_invitee
  rewarded_ad
  feature_charge
  feature_refund
  admin_adjustment
  account_deleted
  purchase
}

enum CreditFeature {
  auto_captions
}

enum PricingMode {
  per_job
  duration_tiers
}

enum BonusClaimKind {
  email
  install
}

enum ReferralOutcome {
  rewarded
  invitee_ineligible
  inviter_capped
}

/// One refresh-token family: one signed-in install.
model UserSession {
  id         String    @id @default(cuid())
  userId     String
  deviceId   String
  createdAt  DateTime  @default(now())
  lastUsedAt DateTime  @default(now())
  revokedAt  DateTime?

  user          User               @relation(fields: [userId], references: [id], onDelete: Cascade)
  device        Device             @relation(fields: [deviceId], references: [id])
  refreshTokens UserRefreshToken[]

  @@index([userId, revokedAt])
}

model UserRefreshToken {
  id        String    @id @default(cuid())
  tokenHash String    @unique
  sessionId String
  expiresAt DateTime
  revokedAt DateTime?
  createdAt DateTime  @default(now())

  session UserSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  @@index([sessionId])
}

/// Append-only. Written only by LedgerService; the user's creditBalance is its sum.
model CreditTransaction {
  id             String       @id @default(cuid())
  userId         String
  type           CreditTxType
  amount         Int
  balanceAfter   Int
  idempotencyKey String       @unique
  reference      String?
  metadata       Json?
  createdAt      DateTime     @default(now())

  user User @relation(fields: [userId], references: [id])

  @@index([userId, createdAt(sort: Desc)])
  @@index([type, createdAt])
}

/// Who already received a signup bonus: HMACs only, no user link, kept after deletion.
model BonusClaim {
  id        String         @id @default(cuid())
  kind      BonusClaimKind
  hmac      String
  createdAt DateTime       @default(now())

  @@unique([kind, hmac])
}

model Referral {
  id        String          @id @default(cuid())
  inviterId String
  inviteeId String          @unique
  outcome   ReferralOutcome
  createdAt DateTime        @default(now())

  inviter User @relation("ReferralInviter", fields: [inviterId], references: [id])
  invitee User @relation("ReferralInvitee", fields: [inviteeId], references: [id])

  @@index([inviterId, createdAt])
}

/// Exactly one row, id "default", inserted by the migration and edited from the admin API.
model CreditSettings {
  id                       String   @id
  signupBonusCredits       Int
  adRewardCredits          Int
  adDailyCap               Int
  referralInviterCredits   Int
  referralInviteeCredits   Int
  referralCapCount         Int
  referralCapDays          Int
  ipSignupLimitPer24h      Int
  disposableEmailDomains   String[]
  otpMaxAttempts           Int
  otpResendCooldownSeconds Int
  otpPerEmailPerHour       Int
  otpPerDevicePerHour      Int
  otpPerIpPerHour          Int
  updatedById              String?
  updatedAt                DateTime @updatedAt
}

/// Immutable once created; a price change is a new version. One active per feature (partial index).
model PricingRule {
  id            String        @id @default(cuid())
  feature       CreditFeature
  version       Int
  mode          PricingMode
  perJobCredits Int?
  tiers         Json?
  isActive      Boolean       @default(false)
  note          String?
  createdById   String
  createdAt     DateTime      @default(now())
  activatedAt   DateTime?

  @@unique([feature, version])
}
```

Run `npx prisma format`.

- [ ] **Step 4: Assemble the migration offline**

```bash
npx prisma migrate diff --from-schema "$SCRATCH/schema-before-credits.prisma" --to-schema prisma/schema.prisma --script | grep -v 'injected env' > "$SCRATCH/credits.sql"
head -3 "$SCRATCH/credits.sql"   # must start with "-- CreateEnum" (no dotenv banner)
grep -c '^CREATE\|^ALTER' "$SCRATCH/credits.sql"
```

The output must only create the five enums, the six new tables, their indexes and foreign keys, and alter `User` and `Device` (new columns, indexes, foreign keys). If it drops or changes anything else, stop.

```bash
M=prisma/migrations/20261003120000_accounts_and_credits/migration.sql
mkdir -p "$(dirname "$M")"
{ printf -- '-- Accounts and credits. See docs/superpowers/specs/2026-10-03-accounts-and-credits-design.md.\n\n'
  cat "$SCRATCH/credits.sql"
  printf -- '\n-- A balance can never go below zero, whatever the application does.\n'
  printf -- 'ALTER TABLE "User" ADD CONSTRAINT "User_creditBalance_nonnegative" CHECK ("creditBalance" >= 0);\n'
  printf -- '\n-- At most one active pricing rule per feature.\n'
  printf -- 'CREATE UNIQUE INDEX "PricingRule_one_active" ON "PricingRule"("feature") WHERE "isActive";\n'
  printf -- '\n-- Default credit settings; every value is editable from the admin API.\n'
  printf -- 'INSERT INTO "CreditSettings" ("id", "signupBonusCredits", "adRewardCredits", "adDailyCap", "referralInviterCredits", "referralInviteeCredits", "referralCapCount", "referralCapDays", "ipSignupLimitPer24h", "disposableEmailDomains", "otpMaxAttempts", "otpResendCooldownSeconds", "otpPerEmailPerHour", "otpPerDevicePerHour", "otpPerIpPerHour", "updatedAt")\n'
  printf -- "VALUES ('default', 100, 5, 10, 20, 20, 10, 30, 10, ARRAY['10minutemail.com', 'discard.email', 'dispostable.com', 'emailondeck.com', 'fakeinbox.com', 'getnada.com', 'guerrillamail.com', 'guerrillamail.net', 'maildrop.cc', 'mailinator.com', 'mailnesia.com', 'mintemail.com', 'moakt.com', 'mohmal.com', 'sharklasers.com', 'temp-mail.org', 'tempmail.com', 'throwawaymail.com', 'trashmail.com', 'yopmail.com'], 5, 60, 5, 10, 20, CURRENT_TIMESTAMP);\n"
} > "$M"
head -c 3 "$M" | od -An -tx1   # must not be ef bb bf
```

- [ ] **Step 5: Regenerate and run**

Run: `npx prisma generate && npx jest src/prisma && npm run typecheck`
Expected: PASS (the existing `provider-schema.spec.ts` still passes).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261003120000_accounts_and_credits src/generated/prisma src/prisma/credits-schema.spec.ts
git commit -m "feat: accounts and credits tables

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Error codes and `appError`

**Files:**
- Modify: `src/core/errors/error-codes.ts`, `src/core/errors/http-exception.filter.ts` (HttpException branch of `classify`), `src/core/audit/audit.service.ts` (`AuditEntry.actorType`)
- Create: `src/core/errors/app-error.ts`
- Test: `src/core/errors/error-codes.spec.ts`, `src/core/errors/http-exception.filter.spec.ts`

**Interfaces:**
- Produces: `appError(status: number, code: ErrorCode, message: string, details?: Record<string, unknown>): HttpException`; the new `ErrorCode` members listed below; `AuditEntry.actorType: 'admin' | 'system' | 'user'`.

- [ ] **Step 1: Write the failing tests**

Add to `src/core/errors/error-codes.spec.ts`:

```ts
  it.each([
    'SIGN_IN_REQUIRED', 'DEVICE_NOT_REGISTERED', 'GOOGLE_TOKEN_INVALID', 'GOOGLE_EMAIL_UNVERIFIED',
    'SIGN_IN_METHOD_UNAVAILABLE', 'EMAIL_DOMAIN_NOT_ALLOWED', 'ACCOUNT_LINK_CONFLICT', 'OTP_INVALID',
    'OTP_EXPIRED', 'OTP_ATTEMPTS_EXCEEDED', 'OTP_RESEND_TOO_SOON', 'USERNAME_INVALID', 'USERNAME_TAKEN',
    'ALREADY_CLAIMED', 'REFERRAL_CODE_INVALID', 'INSUFFICIENT_CREDITS', 'ACCOUNT_SUSPENDED',
    'INVALID_AUDIO', 'AD_DAILY_CAP_REACHED',
  ])('has %s', (code) => {
    expect((ErrorCode as Record<string, string>)[code]).toBe(code);
  });
```

Add to `src/core/errors/http-exception.filter.spec.ts` (import `appError` from `./app-error`):

```ts
  it('passes on the details an app error carries', () => {
    const { host, json, status } = hostFor();
    filter.catch(
      appError(402, ErrorCode.INSUFFICIENT_CREDITS, 'Not enough credits.', { required: 6, balance: 2 }),
      host,
    );
    expect(status).toHaveBeenCalledWith(402);
    expect(json.mock.calls[0][0].error).toMatchObject({
      code: 'INSUFFICIENT_CREDITS',
      message: 'Not enough credits.',
      details: { required: 6, balance: 2 },
    });
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx jest src/core/errors`
Expected: FAIL — `./app-error` not found; the new codes are undefined.

- [ ] **Step 3: Implement**

In `src/core/errors/error-codes.ts`, add before `REQUEST_FAILED`:

```ts
  SIGN_IN_REQUIRED = 'SIGN_IN_REQUIRED',
  DEVICE_NOT_REGISTERED = 'DEVICE_NOT_REGISTERED',
  GOOGLE_TOKEN_INVALID = 'GOOGLE_TOKEN_INVALID',
  GOOGLE_EMAIL_UNVERIFIED = 'GOOGLE_EMAIL_UNVERIFIED',
  SIGN_IN_METHOD_UNAVAILABLE = 'SIGN_IN_METHOD_UNAVAILABLE',
  EMAIL_DOMAIN_NOT_ALLOWED = 'EMAIL_DOMAIN_NOT_ALLOWED',
  ACCOUNT_LINK_CONFLICT = 'ACCOUNT_LINK_CONFLICT',
  OTP_INVALID = 'OTP_INVALID',
  OTP_EXPIRED = 'OTP_EXPIRED',
  OTP_ATTEMPTS_EXCEEDED = 'OTP_ATTEMPTS_EXCEEDED',
  OTP_RESEND_TOO_SOON = 'OTP_RESEND_TOO_SOON',
  USERNAME_INVALID = 'USERNAME_INVALID',
  USERNAME_TAKEN = 'USERNAME_TAKEN',
  ALREADY_CLAIMED = 'ALREADY_CLAIMED',
  REFERRAL_CODE_INVALID = 'REFERRAL_CODE_INVALID',
  INSUFFICIENT_CREDITS = 'INSUFFICIENT_CREDITS',
  ACCOUNT_SUSPENDED = 'ACCOUNT_SUSPENDED',
  INVALID_AUDIO = 'INVALID_AUDIO',
  AD_DAILY_CAP_REACHED = 'AD_DAILY_CAP_REACHED',
```

`src/core/errors/app-error.ts`:

```ts
import { HttpException } from '@nestjs/common';

import { ErrorCode } from './error-codes';

/**
 * An HTTP error with a precise code. AllExceptionsFilter keeps the code and
 * passes `details` through, so the app can act on them (e.g. required/balance).
 */
export function appError(
  status: number,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): HttpException {
  return new HttpException({ code, message, ...(details ? { details } : {}) }, status);
}
```

In `src/core/errors/http-exception.filter.ts`, in the `HttpException` branch, replace the final `return { status, code: isErrorCode(bodyCode) ? … }` block with:

```ts
      const bodyDetails =
        typeof body === 'object' && body !== null ? (body as { details?: unknown }).details : undefined;

      return {
        status,
        code: isErrorCode(bodyCode) ? bodyCode : this.codeForStatus(status),
        message: Array.isArray(raw) ? raw.join(', ') : raw ?? exception.message,
        ...(bodyDetails !== undefined ? { details: bodyDetails } : {}),
      };
```

In `src/core/audit/audit.service.ts`, change `actorType: 'admin' | 'system';` to `actorType: 'admin' | 'system' | 'user';`.

- [ ] **Step 4: Run the tests**

Run: `npx jest src/core && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/errors src/core/audit
git commit -m "feat: account and credit error codes; appError with details

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Shared building blocks — hashing, rate limits, settings, ad allowance

**Files:**
- Create: `src/core/identity/email.ts`, `src/core/identity/identity-hash.service.ts`, `src/core/rate-limit/rate-limiter.ts`, `src/core/identity/identity.module.ts`
- Create: `src/modules/credits/credit-settings.service.ts`, `src/modules/credits/credit-settings.module.ts`, `src/modules/credits/ad-allowance.ts`
- Create: `test/fakes/fake-redis.ts`
- Modify: `src/app.module.ts` (import `IdentityModule`)
- Test: `src/core/identity/email.spec.ts`, `src/core/identity/identity-hash.service.spec.ts`, `src/core/rate-limit/rate-limiter.spec.ts`, `src/modules/credits/credit-settings.service.spec.ts`, `src/modules/credits/ad-allowance.spec.ts`

**Interfaces:**
- Produces:
  - `normalizeEmail(email: string): string`, `canonicalEmail(email: string): string`, `emailDomain(email: string): string`
  - `IdentityHashService.hash(kind: string, value: string): string` (hex HMAC-SHA256)
  - `RateLimiter.increment(key: string, windowSeconds: number): Promise<number>`, `RateLimiter.hit(key: string, limit: number, windowSeconds: number): Promise<void>` (throws `429 RATE_LIMITED {retryAfterSeconds}`)
  - `IdentityModule` (global: exports both)
  - `CreditSettingsService.get(): Promise<CreditSettings>`, `.update(patch: CreditSettingsPatch, adminId: string): Promise<CreditSettings>`; `type CreditSettingsPatch = Partial<Omit<CreditSettings, 'id' | 'updatedById' | 'updatedAt'>>`; `CreditSettingsModule`
  - `startOfUtcDay(now: Date): Date`, `nextUtcMidnight(now: Date): Date`, `adsUsedToday(db, userId: string, now?: Date): Promise<number>`
  - `FakeRedis` (test only): `get, set(key, value, ...'EX', seconds, 'NX'), incr, ttl, del`, settable `now`.

- [ ] **Step 1: Write the failing tests**

`test/fakes/fake-redis.ts` (test helper, written first because the tests use it):

```ts
/** The few ioredis calls this codebase uses, in memory, with a settable clock. */
export class FakeRedis {
  now = (): number => Date.now();
  private store = new Map<string, { value: string; expiresAt: number | null }>();

  private live(key: string) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string | number, ...args: Array<string | number>): Promise<'OK' | null> {
    let ttl: number | null = null;
    let nx = false;
    for (let i = 0; i < args.length; i += 1) {
      const flag = String(args[i]).toUpperCase();
      if (flag === 'EX') ttl = Number(args[(i += 1)]);
      else if (flag === 'NX') nx = true;
    }
    if (nx && this.live(key)) return null;
    this.store.set(key, { value: String(value), expiresAt: ttl === null ? null : this.now() + ttl * 1000 });
    return 'OK';
  }

  async incr(key: string): Promise<number> {
    const entry = this.live(key);
    const next = Number(entry?.value ?? '0') + 1;
    this.store.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? null });
    return next;
  }

  async ttl(key: string): Promise<number> {
    const entry = this.live(key);
    if (!entry) return -2;
    if (entry.expiresAt === null) return -1;
    return Math.ceil((entry.expiresAt - this.now()) / 1000);
  }

  async del(...keys: string[]): Promise<number> {
    return keys.filter((k) => this.store.delete(k)).length;
  }

  values(): string[] {
    return [...this.store.values()].map((e) => e.value);
  }
}
```

`src/core/identity/email.spec.ts`:

```ts
import { canonicalEmail, emailDomain, normalizeEmail } from './email';

describe('email helpers', () => {
  it('normalises case and whitespace', () => {
    expect(normalizeEmail('  Ann@Example.COM ')).toBe('ann@example.com');
    expect(emailDomain('ann@mail.example.com')).toBe('mail.example.com');
  });

  it.each([
    ['ann+promo@example.com', 'ann@example.com'],
    ['A.nn+x@Gmail.com', 'ann@gmail.com'],
    ['a.n.n@googlemail.com', 'ann@gmail.com'],
    ['a.nn@example.com', 'a.nn@example.com'],
  ])('canonicalises %s for the bonus key', (input, expected) => {
    expect(canonicalEmail(input)).toBe(expected);
  });
});
```

`src/core/identity/identity-hash.service.spec.ts`:

```ts
import { IdentityHashService } from './identity-hash.service';

describe('IdentityHashService', () => {
  const hashes = new IdentityHashService({ identityHmacSecret: 'h'.repeat(48) } as never);

  it('is stable, keyed by kind, and never contains the value', () => {
    const a = hashes.hash('email', 'ann@example.com');
    expect(a).toBe(hashes.hash('email', 'ann@example.com'));
    expect(a).not.toBe(hashes.hash('install', 'ann@example.com'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('depends on the secret', () => {
    const other = new IdentityHashService({ identityHmacSecret: 'x'.repeat(48) } as never);
    expect(other.hash('email', 'ann@example.com')).not.toBe(hashes.hash('email', 'ann@example.com'));
  });
});
```

`src/core/rate-limit/rate-limiter.spec.ts`:

```ts
import { HttpException } from '@nestjs/common';

import { FakeRedis } from '../../../test/fakes/fake-redis';
import { RateLimiter } from './rate-limiter';

describe('RateLimiter', () => {
  it('allows up to the limit in a window, then answers 429 with the wait', async () => {
    const redis = new FakeRedis();
    const limiter = new RateLimiter(redis as never);
    await limiter.hit('k', 2, 60);
    await limiter.hit('k', 2, 60);

    const error = (await limiter.hit('k', 2, 60).catch((e: unknown) => e)) as HttpException;
    expect(error.getStatus()).toBe(429);
    expect(error.getResponse()).toMatchObject({ code: 'RATE_LIMITED', details: { retryAfterSeconds: 60 } });
  });

  it('starts a fresh window after the old one expires', async () => {
    const redis = new FakeRedis();
    let t = 0;
    redis.now = () => t;
    const limiter = new RateLimiter(redis as never);
    await limiter.hit('k', 1, 60);
    t = 61_000;
    await expect(limiter.hit('k', 1, 60)).resolves.toBeUndefined();
  });

  it('counts without throwing when asked to', async () => {
    const limiter = new RateLimiter(new FakeRedis() as never);
    expect(await limiter.increment('ip', 86_400)).toBe(1);
    expect(await limiter.increment('ip', 86_400)).toBe(2);
  });
});
```

`src/modules/credits/credit-settings.service.spec.ts`:

```ts
import { CreditSettingsService } from './credit-settings.service';

const ROW = { id: 'default', signupBonusCredits: 100, adRewardCredits: 5, adDailyCap: 10 };

function build() {
  const prisma = {
    creditSettings: {
      findUniqueOrThrow: jest.fn(async () => ({ ...ROW })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...ROW, ...data })),
    },
  };
  const audit = { record: jest.fn(async (_entry: unknown) => undefined) };
  return { svc: new CreditSettingsService(prisma as never, audit as never), prisma, audit };
}

describe('CreditSettingsService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reads the settings row and caches it for 30 seconds', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { svc, prisma } = build();
    await svc.get();
    await svc.get();
    expect(prisma.creditSettings.findUniqueOrThrow).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_030_001);
    await svc.get();
    expect(prisma.creditSettings.findUniqueOrThrow).toHaveBeenCalledTimes(2);
  });

  it('updates, drops the cache, and audits before and after', async () => {
    const { svc, prisma, audit } = build();
    await svc.get();
    const updated = await svc.update({ adRewardCredits: 8 }, 'admin-1');
    expect(updated.adRewardCredits).toBe(8);
    expect(prisma.creditSettings.update).toHaveBeenCalledWith({
      where: { id: 'default' },
      data: { adRewardCredits: 8, updatedById: 'admin-1' },
    });
    await svc.get();
    expect(prisma.creditSettings.findUniqueOrThrow).toHaveBeenCalledTimes(3);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'credits.settings.updated', actorId: 'admin-1', actorType: 'admin' }),
    );
  });
});
```

`src/modules/credits/ad-allowance.spec.ts`:

```ts
import { adsUsedToday, nextUtcMidnight, startOfUtcDay } from './ad-allowance';

describe('ad allowance', () => {
  it('uses UTC days', () => {
    const t = new Date('2026-10-03T23:30:00+01:00'); // 22:30 UTC
    expect(startOfUtcDay(t).toISOString()).toBe('2026-10-03T00:00:00.000Z');
    expect(nextUtcMidnight(t).toISOString()).toBe('2026-10-04T00:00:00.000Z');
  });

  it("counts today's rewarded ads for the user", async () => {
    const db = { creditTransaction: { count: jest.fn(async () => 3) } };
    await expect(adsUsedToday(db as never, 'u1', new Date('2026-10-03T12:00:00Z'))).resolves.toBe(3);
    expect(db.creditTransaction.count).toHaveBeenCalledWith({
      where: { userId: 'u1', type: 'rewarded_ad', createdAt: { gte: new Date('2026-10-03T00:00:00Z') } },
    });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx jest src/core/identity src/core/rate-limit src/modules/credits`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/core/identity/email.ts`:

```ts
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function emailDomain(email: string): string {
  return normalizeEmail(email).split('@')[1] ?? '';
}

/**
 * The form used only for the signup-bonus key: "+tag" removed everywhere,
 * dots removed for Gmail. ann+1@gmail.com and a.nn@gmail.com are one inbox,
 * so they are one claim. The account keeps the address as entered.
 */
export function canonicalEmail(email: string): string {
  const [local = '', domain = ''] = normalizeEmail(email).split('@');
  const name = local.split('+')[0];
  if (domain === 'gmail.com' || domain === 'googlemail.com') return `${name.replace(/\./g, '')}@gmail.com`;
  return `${name}@${domain}`;
}
```

`src/core/identity/identity-hash.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';

import { appAuthConfig, type AppAuthConfig } from '../../config';

/** Keyed hashes for everything we keep about a person or a device. */
@Injectable()
export class IdentityHashService {
  constructor(@Inject(appAuthConfig.KEY) private readonly cfg: AppAuthConfig) {}

  hash(kind: string, value: string): string {
    return createHmac('sha256', this.cfg.identityHmacSecret).update(`${kind}:${value}`).digest('hex');
  }
}
```

`src/core/rate-limit/rate-limiter.ts`:

```ts
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';

import { REDIS } from '../cache/cache.service';
import { appError } from '../errors/app-error';
import { ErrorCode } from '../errors/error-codes';

/** Fixed-window counters in Redis. */
@Injectable()
export class RateLimiter {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async increment(key: string, windowSeconds: number): Promise<number> {
    const k = `rl:${key}`;
    // SET NX first, so the key carries its expiry before it is ever counted.
    await this.redis.set(k, '0', 'EX', windowSeconds, 'NX');
    return this.redis.incr(k);
  }

  async hit(key: string, limit: number, windowSeconds: number): Promise<void> {
    if ((await this.increment(key, windowSeconds)) <= limit) return;
    const ttl = await this.redis.ttl(`rl:${key}`);
    throw appError(HttpStatus.TOO_MANY_REQUESTS, ErrorCode.RATE_LIMITED, 'Too many requests. Try again later.', {
      retryAfterSeconds: ttl > 0 ? ttl : windowSeconds,
    });
  }
}
```

`src/core/identity/identity.module.ts`:

```ts
import { Global, Module } from '@nestjs/common';

import { RateLimiter } from '../rate-limit/rate-limiter';
import { IdentityHashService } from './identity-hash.service';

@Global()
@Module({ providers: [IdentityHashService, RateLimiter], exports: [IdentityHashService, RateLimiter] })
export class IdentityModule {}
```

`src/modules/credits/credit-settings.service.ts`:

```ts
import { Injectable } from '@nestjs/common';

import { AuditService } from '../../core/audit/audit.service';
import type { CreditSettings } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export type CreditSettingsPatch = Partial<Omit<CreditSettings, 'id' | 'updatedById' | 'updatedAt'>>;

const CACHE_MS = 30_000;

/** The one settings row the admin edits: every amount, cap and limit. */
@Injectable()
export class CreditSettingsService {
  private cached?: { value: CreditSettings; expiresAt: number };

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(): Promise<CreditSettings> {
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached.value;
    const value = await this.prisma.creditSettings.findUniqueOrThrow({ where: { id: 'default' } });
    this.cached = { value, expiresAt: Date.now() + CACHE_MS };
    return value;
  }

  async update(patch: CreditSettingsPatch, adminId: string): Promise<CreditSettings> {
    const before = await this.get();
    const value = await this.prisma.creditSettings.update({
      where: { id: 'default' },
      data: { ...patch, updatedById: adminId },
    });
    this.cached = undefined;
    await this.audit.record({
      actorId: adminId,
      actorType: 'admin',
      action: 'credits.settings.updated',
      entityType: 'CreditSettings',
      entityId: 'default',
      before,
      after: value,
    });
    return value;
  }
}
```

`src/modules/credits/credit-settings.module.ts`:

```ts
import { Module } from '@nestjs/common';

import { CreditSettingsService } from './credit-settings.service';

@Module({ providers: [CreditSettingsService], exports: [CreditSettingsService] })
export class CreditSettingsModule {}
```

`src/modules/credits/ad-allowance.ts`:

```ts
import { CreditTxType } from '../../generated/prisma/enums';

const DAY_MS = 86_400_000;

/** Ad caps reset at UTC midnight for everyone. */
export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function nextUtcMidnight(now: Date): Date {
  return new Date(startOfUtcDay(now).getTime() + DAY_MS);
}

interface CountsTransactions {
  creditTransaction: { count(args: { where: Record<string, unknown> }): Promise<number> };
}

export function adsUsedToday(db: CountsTransactions, userId: string, now = new Date()): Promise<number> {
  return db.creditTransaction.count({
    where: { userId, type: CreditTxType.rewarded_ad, createdAt: { gte: startOfUtcDay(now) } },
  });
}
```

In `src/app.module.ts`, import `IdentityModule` from `./core/identity/identity.module` and add it to `imports` after `AuditModule`.

- [ ] **Step 4: Run the tests**

Run: `npx jest src/core src/modules/credits && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/identity src/core/rate-limit src/modules/credits test/fakes/fake-redis.ts src/app.module.ts
git commit -m "feat: identity hashing, rate limiter, credit settings, ad allowance

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The ledger

**Files:**
- Create: `src/modules/credits/ledger.service.ts`, `src/modules/credits/ledger.module.ts`, `src/core/errors/prisma-errors.ts`
- Create: `test/fakes/fake-credit-db.ts`
- Test: `src/modules/credits/ledger.service.spec.ts`

**Interfaces:**
- Consumes: `appError`, `ErrorCode` (Task 3).
- Produces:
  - `interface LedgerEntryInput { userId: string; type: CreditTxType; amount: number; reference: string; metadata?: Record<string, unknown>; requireActive?: boolean }`
  - `interface LedgerResult { transaction: CreditTransaction; replayed: boolean }`
  - `LedgerService.post(input: LedgerEntryInput, tx?: Prisma.TransactionClient): Promise<LedgerResult>` — throws `402 INSUFFICIENT_CREDITS {required, balance}`, `403 ACCOUNT_SUSPENDED` (only with `requireActive`), `404 NOT_FOUND` (deleted/missing account). Inside an outer `tx`, a duplicate key throws instead of replaying.
  - `isUniqueViolation(err: unknown): boolean` (`src/core/errors/prisma-errors.ts`)
  - `LedgerModule` exports `LedgerService`
  - `FakeCreditDb` (test only): `addUser(id, balance?, status?)`, `users`, `ledger`, `prisma()` (with `$transaction(fn)` that undoes its own writes on throw), `ledgerSum(userId)`, `transactionCalls`. Its client supports `user.updateMany/findUnique/findUniqueOrThrow`, `creditTransaction.create/findUnique/count`, `$queryRaw` (no-op).

- [ ] **Step 1: Write the fake and the failing tests**

`test/fakes/fake-credit-db.ts`:

```ts
type Status = 'active' | 'suspended' | 'deleted';

export interface FakeUser {
  id: string;
  accountStatus: Status;
  creditBalance: number;
}

export interface FakeLedgerRow {
  id: string;
  userId: string;
  type: string;
  amount: number;
  balanceAfter: number;
  idempotencyKey: string;
  reference: string | null;
  metadata: unknown;
  createdAt: Date;
}

// Every call yields first, so concurrent callers interleave the way real
// requests do: an implementation that reads a balance and writes it back
// later overdraws here, exactly as it would in Postgres.
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function uniqueViolation(): Error {
  return Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
}

/** The slice of Prisma the ledger uses, in memory, with per-transaction rollback. */
export class FakeCreditDb {
  users = new Map<string, FakeUser>();
  ledger: FakeLedgerRow[] = [];
  transactionCalls = 0;
  private seq = 0;

  addUser(id: string, creditBalance = 0, accountStatus: Status = 'active'): void {
    this.users.set(id, { id, accountStatus, creditBalance });
  }

  ledgerSum(userId: string): number {
    return this.ledger.filter((r) => r.userId === userId).reduce((sum, r) => sum + r.amount, 0);
  }

  client(undo?: Array<() => void>) {
    const db = this;
    return {
      user: {
        async updateMany(args: {
          where: { id: string; accountStatus: Status | { not: Status }; creditBalance?: { gte: number } };
          data: { creditBalance: { increment: number } };
        }) {
          await tick();
          const u = db.users.get(args.where.id);
          const status = args.where.accountStatus;
          const statusOk = !!u && (typeof status === 'string' ? u.accountStatus === status : u.accountStatus !== status.not);
          if (!u || !statusOk || (args.where.creditBalance && u.creditBalance < args.where.creditBalance.gte)) {
            return { count: 0 };
          }
          const inc = args.data.creditBalance.increment;
          u.creditBalance += inc;
          undo?.push(() => {
            u.creditBalance -= inc;
          });
          return { count: 1 };
        },
        async findUnique(args: { where: { id: string } }) {
          await tick();
          const u = db.users.get(args.where.id);
          return u ? { ...u } : null;
        },
        async findUniqueOrThrow(args: { where: { id: string } }) {
          const u = await this.findUnique(args);
          if (!u) throw Object.assign(new Error('No record'), { code: 'P2025' });
          return u;
        },
      },
      creditTransaction: {
        async create(args: { data: Omit<FakeLedgerRow, 'id' | 'createdAt' | 'reference' | 'metadata'> & { reference?: string; metadata?: unknown } }) {
          await tick();
          if (db.ledger.some((r) => r.idempotencyKey === args.data.idempotencyKey)) throw uniqueViolation();
          const row: FakeLedgerRow = {
            id: `tx-${(db.seq += 1)}`,
            reference: args.data.reference ?? null,
            metadata: args.data.metadata ?? null,
            createdAt: new Date(),
            ...args.data,
          };
          db.ledger.push(row);
          undo?.push(() => {
            db.ledger.splice(db.ledger.indexOf(row), 1);
          });
          return { ...row };
        },
        async findUnique(args: { where: { idempotencyKey: string } }) {
          await tick();
          const row = db.ledger.find((r) => r.idempotencyKey === args.where.idempotencyKey);
          return row ? { ...row } : null;
        },
        async count(args: { where: { userId: string; type?: string; createdAt?: { gte: Date } } }) {
          await tick();
          return db.ledger.filter(
            (r) =>
              r.userId === args.where.userId &&
              (args.where.type === undefined || r.type === args.where.type) &&
              (args.where.createdAt === undefined || r.createdAt >= args.where.createdAt.gte),
          ).length;
        },
      },
      async $queryRaw(): Promise<unknown[]> {
        await tick();
        return [];
      },
    };
  }

  /** Hand this to services as their PrismaService. */
  prisma() {
    return {
      ...this.client(),
      $transaction: async <T>(fn: (tx: ReturnType<FakeCreditDb['client']>) => Promise<T>): Promise<T> => {
        this.transactionCalls += 1;
        const undo: Array<() => void> = [];
        try {
          return await fn(this.client(undo));
        } catch (err) {
          for (const step of undo.reverse()) step();
          throw err;
        }
      },
    };
  }
}
```

`src/modules/credits/ledger.service.spec.ts`:

```ts
import { HttpException } from '@nestjs/common';

import { FakeCreditDb } from '../../../test/fakes/fake-credit-db';
import { CreditTxType } from '../../generated/prisma/enums';
import { LedgerService } from './ledger.service';

function build(balance = 0, status: 'active' | 'suspended' | 'deleted' = 'active') {
  const db = new FakeCreditDb();
  db.addUser('u1', balance, status);
  return { db, ledger: new LedgerService(db.prisma() as never) };
}

const grant = (amount: number, reference = 'u1', type: CreditTxType = CreditTxType.signup_bonus) => ({
  userId: 'u1',
  type,
  amount,
  reference,
});
const charge = (amount: number, reference: string) => ({
  userId: 'u1',
  type: CreditTxType.feature_charge,
  amount: -amount,
  reference,
  requireActive: true,
});

async function errorOf(p: Promise<unknown>): Promise<HttpException> {
  return p.then(
    () => {
      throw new Error('expected a failure');
    },
    (e: HttpException) => e,
  );
}

describe('LedgerService.post', () => {
  it('grants credits and records the balance after', async () => {
    const { db, ledger } = build(10);
    const { transaction, replayed } = await ledger.post(grant(100));
    expect(replayed).toBe(false);
    expect(transaction).toMatchObject({ amount: 100, balanceAfter: 110, idempotencyKey: 'signup_bonus:u1' });
    expect(db.users.get('u1')?.creditBalance).toBe(110);
  });

  it('refuses a charge the balance cannot cover, with required and balance, writing nothing', async () => {
    const { db, ledger } = build(5);
    const error = await errorOf(ledger.post(charge(6, 'job-1')));
    expect(error.getStatus()).toBe(402);
    expect(error.getResponse()).toMatchObject({ code: 'INSUFFICIENT_CREDITS', details: { required: 6, balance: 5 } });
    expect(db.users.get('u1')?.creditBalance).toBe(5);
    expect(db.ledger).toHaveLength(0);
  });

  it('never overdraws under concurrent charges', async () => {
    const { db, ledger } = build();
    await ledger.post(grant(100));
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map((n) => ledger.post(charge(30, `job-${n}`))));

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(2);
    expect(db.users.get('u1')?.creditBalance).toBe(10);
    expect(db.ledgerSum('u1')).toBe(10);
  });

  it('applies one reference once, even when two arrive together', async () => {
    const { db, ledger } = build();
    const [a, b] = await Promise.all([
      ledger.post(grant(5, 'admob-tx-1', CreditTxType.rewarded_ad)),
      ledger.post(grant(5, 'admob-tx-1', CreditTxType.rewarded_ad)),
    ]);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(db.users.get('u1')?.creditBalance).toBe(5);
    expect(db.ledger).toHaveLength(1);
  });

  it('replays an earlier charge instead of refusing it after the balance dropped', async () => {
    const { db, ledger } = build();
    await ledger.post(grant(10));
    await ledger.post(charge(10, 'job-1'));
    const again = await ledger.post(charge(10, 'job-1'));
    expect(again.replayed).toBe(true);
    expect(db.users.get('u1')?.creditBalance).toBe(0);
  });

  it('refuses spending for a suspended account but still lets it receive credits', async () => {
    const { ledger } = build(50, 'suspended');
    const error = await errorOf(ledger.post(charge(5, 'job-1')));
    expect(error.getStatus()).toBe(403);
    expect(error.getResponse()).toMatchObject({ code: 'ACCOUNT_SUSPENDED' });
    await expect(ledger.post(grant(5, 'adj-1', CreditTxType.admin_adjustment))).resolves.toMatchObject({ replayed: false });
  });

  it('refuses a deleted account', async () => {
    const { ledger } = build(0, 'deleted');
    const error = await errorOf(ledger.post(grant(5)));
    expect(error.getStatus()).toBe(404);
  });

  it('joins an outer transaction instead of opening its own', async () => {
    const { db, ledger } = build();
    const prisma = db.prisma();
    await prisma.$transaction((tx) => ledger.post(grant(5), tx as never));
    expect(db.transactionCalls).toBe(1);
    expect(db.users.get('u1')?.creditBalance).toBe(5);
  });

  it.each([0, 1.5])('rejects the amount %p', async (amount) => {
    const { ledger } = build();
    await expect(ledger.post(grant(amount))).rejects.toThrow('non-zero integers');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx jest src/modules/credits/ledger.service.spec.ts`
Expected: FAIL — `./ledger.service` not found.

- [ ] **Step 3: Implement**

`src/core/errors/prisma-errors.ts`:

```ts
/** Prisma's "unique constraint failed" (also what the pg driver adapter reports). */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}
```

`src/modules/credits/ledger.service.ts`:

```ts
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { isUniqueViolation } from '../../core/errors/prisma-errors';
import type { CreditTransaction, Prisma } from '../../generated/prisma/client';
import { AccountStatus, CreditTxType } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';

export interface LedgerEntryInput {
  userId: string;
  type: CreditTxType;
  /** Signed, non-zero integer. */
  amount: number;
  /** What this entry is for (job id, AdMob transaction id, referral id, …). One entry per type+reference, ever. */
  reference: string;
  metadata?: Record<string, unknown>;
  /** Spending paths: a suspended account cannot. Grants leave this off. */
  requireActive?: boolean;
}

export interface LedgerResult {
  transaction: CreditTransaction;
  replayed: boolean;
}

/**
 * The only writer of CreditTransaction and User.creditBalance. One guarded
 * UPDATE moves the balance only if it stays >= 0, and the insert's unique
 * idempotency key makes every grant or charge happen at most once. Both run
 * in one transaction, so the cached balance always equals the ledger sum.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async post(input: LedgerEntryInput, tx?: Prisma.TransactionClient): Promise<LedgerResult> {
    if (!Number.isInteger(input.amount) || input.amount === 0) {
      throw new Error('Ledger amounts are non-zero integers.');
    }
    const key = `${input.type}:${input.reference}`;
    const db = tx ?? this.prisma;

    // Already applied: answer with it, even if the balance could not cover it now.
    const existing = await db.creditTransaction.findUnique({ where: { idempotencyKey: key } });
    if (existing) return { transaction: existing, replayed: true };

    if (tx) return { transaction: await this.apply(tx, input, key), replayed: false };

    try {
      return { transaction: await this.prisma.$transaction((t) => this.apply(t, input, key)), replayed: false };
    } catch (err) {
      if (isUniqueViolation(err)) {
        // A concurrent request with the same key committed first.
        const winner = await this.prisma.creditTransaction.findUnique({ where: { idempotencyKey: key } });
        if (winner) return { transaction: winner, replayed: true };
      }
      throw err;
    }
  }

  private async apply(tx: Prisma.TransactionClient, input: LedgerEntryInput, key: string): Promise<CreditTransaction> {
    const { userId, amount } = input;
    const updated = await tx.user.updateMany({
      where: {
        id: userId,
        accountStatus: input.requireActive ? AccountStatus.active : { not: AccountStatus.deleted },
        ...(amount < 0 ? { creditBalance: { gte: -amount } } : {}),
      },
      data: { creditBalance: { increment: amount } },
    });
    if (updated.count === 0) throw await this.refusal(tx, userId, amount);

    // The UPDATE holds the row lock until commit, so this reads our own result.
    const { creditBalance } = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { creditBalance: true },
    });
    return tx.creditTransaction.create({
      data: {
        userId,
        type: input.type,
        amount,
        balanceAfter: creditBalance,
        idempotencyKey: key,
        reference: input.reference,
        ...(input.metadata ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
      },
    });
  }

  private async refusal(tx: Prisma.TransactionClient, userId: string, amount: number): Promise<HttpException> {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { accountStatus: true, creditBalance: true },
    });
    if (!user || user.accountStatus === AccountStatus.deleted) {
      return appError(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'This account no longer exists.');
    }
    if (user.accountStatus === AccountStatus.suspended) {
      return appError(HttpStatus.FORBIDDEN, ErrorCode.ACCOUNT_SUSPENDED, 'This account is suspended. Contact support.');
    }
    return appError(HttpStatus.PAYMENT_REQUIRED, ErrorCode.INSUFFICIENT_CREDITS, 'Not enough credits.', {
      required: -amount,
      balance: user.creditBalance,
    });
  }
}
```

`src/modules/credits/ledger.module.ts`:

```ts
import { Module } from '@nestjs/common';

import { LedgerService } from './ledger.service';

@Module({ providers: [LedgerService], exports: [LedgerService] })
export class LedgerModule {}
```

- [ ] **Step 4: Run the tests**

Run: `npx jest src/modules/credits && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/credits src/core/errors/prisma-errors.ts test/fakes/fake-credit-db.ts
git commit -m "feat: credit ledger that cannot overdraw and applies each entry once

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Email sender and one-time codes

**Files:**
- Create: `src/modules/accounts/email-sender.ts`, `src/modules/accounts/otp.service.ts`
- Test: `src/modules/accounts/email-sender.spec.ts`, `src/modules/accounts/otp.service.spec.ts`

**Interfaces:**
- Consumes: `IdentityHashService`, `RateLimiter`, `CreditSettingsService` (Task 4), `REDIS`, `appError`.
- Produces:
  - `EMAIL_SENDER` token; `interface EmailSender { send(message: { to: string; subject: string; text: string }): Promise<void> }`; `LogEmailSender`, `SmtpEmailSender`; `createEmailSender(cfg: EmailConfig): EmailSender`
  - `type OtpPurpose = 'sign_in' | 'delete_account'`
  - `OtpService.send(purpose, email, scope: { installId?: string; ip?: string }): Promise<{ resendAfterSeconds: number; expiresInSeconds: number }>`
  - `OtpService.verify(purpose, email, code): Promise<void>` (throws `OTP_EXPIRED` 422, `OTP_INVALID` 422 `{attemptsLeft}`, `OTP_ATTEMPTS_EXCEEDED` 429)
  - `OTP_TTL_SECONDS = 600`

- [ ] **Step 1: Install nodemailer**

Run: `npm install nodemailer@^10.0.14`
Expected: added to `dependencies` (it ships its own types).

- [ ] **Step 2: Write the failing tests**

`src/modules/accounts/email-sender.spec.ts`:

```ts
import { Logger } from '@nestjs/common';

import { LogEmailSender, SmtpEmailSender } from './email-sender';

describe('email senders', () => {
  it('the log sender prints the message (development only)', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    await new LogEmailSender().send({ to: 'ann@example.com', subject: 'Code', text: 'Your code is 123456.' });
    expect(String(log.mock.calls[0][0])).toContain('123456');
    log.mockRestore();
  });

  it('the SMTP sender sends from the configured address', async () => {
    const transport = { sendMail: jest.fn(async () => ({ messageId: 'm1' })) };
    await new SmtpEmailSender(transport as never, 'SlimShot <no-reply@example.com>').send({
      to: 'ann@example.com',
      subject: 'Code',
      text: 'Your code is 123456.',
    });
    expect(transport.sendMail).toHaveBeenCalledWith({
      from: 'SlimShot <no-reply@example.com>',
      to: 'ann@example.com',
      subject: 'Code',
      text: 'Your code is 123456.',
    });
  });
});
```

`src/modules/accounts/otp.service.spec.ts`:

```ts
import { HttpException } from '@nestjs/common';

import { FakeRedis } from '../../../test/fakes/fake-redis';
import { IdentityHashService } from '../../core/identity/identity-hash.service';
import { RateLimiter } from '../../core/rate-limit/rate-limiter';
import { OtpService } from './otp.service';

const LIMITS = {
  otpMaxAttempts: 5,
  otpResendCooldownSeconds: 60,
  otpPerEmailPerHour: 5,
  otpPerDevicePerHour: 10,
  otpPerIpPerHour: 20,
};

function build(overrides: Partial<typeof LIMITS> = {}) {
  const redis = new FakeRedis();
  let t = 1_000_000;
  redis.now = () => t;
  const hashes = new IdentityHashService({ identityHmacSecret: 'h'.repeat(48) } as never);
  const settings = { get: jest.fn(async () => ({ ...LIMITS, ...overrides })) };
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const email = { send: jest.fn(async (m: { to: string; subject: string; text: string }) => void sent.push(m)) };
  const otp = new OtpService(redis as never, hashes, settings as never, new RateLimiter(redis as never), email);
  return {
    otp,
    redis,
    sent,
    codeOf: () => /\b(\d{6})\b/.exec(sent[sent.length - 1].text)?.[1] ?? '',
    advance: (seconds: number) => (t += seconds * 1000),
  };
}

async function errorOf(p: Promise<unknown>): Promise<HttpException> {
  return p.then(() => {
    throw new Error('expected a failure');
  }, (e: HttpException) => e);
}

describe('OtpService', () => {
  it('emails a 6-digit code and stores only its hash', async () => {
    const { otp, redis, sent, codeOf } = build();
    await expect(otp.send('sign_in', 'ann@example.com', {})).resolves.toEqual({
      resendAfterSeconds: 60,
      expiresInSeconds: 600,
    });
    expect(sent[0].to).toBe('ann@example.com');
    expect(codeOf()).toMatch(/^\d{6}$/);
    expect(redis.values().join(' ')).not.toContain(codeOf());
  });

  it('accepts the right code once', async () => {
    const { otp, codeOf } = build();
    await otp.send('sign_in', 'ann@example.com', {});
    const code = codeOf();
    await expect(otp.verify('sign_in', 'ann@example.com', code)).resolves.toBeUndefined();
    expect((await errorOf(otp.verify('sign_in', 'ann@example.com', code))).getResponse()).toMatchObject({ code: 'OTP_EXPIRED' });
  });

  it('expires after 10 minutes', async () => {
    const { otp, codeOf, advance } = build();
    await otp.send('sign_in', 'ann@example.com', {});
    advance(601);
    const error = await errorOf(otp.verify('sign_in', 'ann@example.com', codeOf()));
    expect(error.getStatus()).toBe(422);
    expect(error.getResponse()).toMatchObject({ code: 'OTP_EXPIRED' });
  });

  it('counts wrong codes and kills the code on the fifth', async () => {
    const { otp, codeOf } = build();
    await otp.send('sign_in', 'ann@example.com', {});
    const right = codeOf();
    const wrong = right === '000000' ? '111111' : '000000';

    const first = await errorOf(otp.verify('sign_in', 'ann@example.com', wrong));
    expect(first.getStatus()).toBe(422);
    expect(first.getResponse()).toMatchObject({ code: 'OTP_INVALID', details: { attemptsLeft: 4 } });
    for (let i = 0; i < 3; i += 1) await otp.verify('sign_in', 'ann@example.com', wrong).catch(() => undefined);
    const fifth = await errorOf(otp.verify('sign_in', 'ann@example.com', wrong));
    expect(fifth.getStatus()).toBe(429);
    expect(fifth.getResponse()).toMatchObject({ code: 'OTP_ATTEMPTS_EXCEEDED' });
    expect((await errorOf(otp.verify('sign_in', 'ann@example.com', right))).getResponse()).toMatchObject({ code: 'OTP_EXPIRED' });
  });

  it('enforces the resend cooldown', async () => {
    const { otp, advance } = build();
    await otp.send('sign_in', 'ann@example.com', {});
    const error = await errorOf(otp.send('sign_in', 'ann@example.com', {}));
    expect(error.getStatus()).toBe(429);
    expect(error.getResponse()).toMatchObject({ code: 'OTP_RESEND_TOO_SOON', details: { retryAfterSeconds: 60 } });
    advance(61);
    await expect(otp.send('sign_in', 'ann@example.com', {})).resolves.toBeDefined();
  });

  it.each([
    ['email', { otpPerEmailPerHour: 2 }, () => ({})],
    ['install', { otpPerDevicePerHour: 2 }, (n: number) => ({ installId: 'dev-1', email: `p${n}@example.com` })],
    ['IP', { otpPerIpPerHour: 2 }, (n: number) => ({ ip: '10.0.0.1', email: `q${n}@example.com` })],
  ])('limits codes per %s per hour', async (_label, limits, scopeFor) => {
    const { otp } = build({ otpResendCooldownSeconds: 0, ...limits });
    const send = (n: number) => {
      const { email, ...scope } = { email: 'ann@example.com', ...(scopeFor as (n: number) => Record<string, string>)(n) };
      return otp.send('sign_in', email, scope);
    };
    await send(1);
    await send(2);
    expect((await errorOf(send(3))).getResponse()).toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('keeps sign-in and deletion codes apart', async () => {
    const { otp, codeOf } = build();
    await otp.send('sign_in', 'ann@example.com', {});
    const signIn = codeOf();
    await otp.send('delete_account', 'ann@example.com', {});
    expect((await errorOf(otp.verify('delete_account', 'ann@example.com', signIn === codeOf() ? '999999' : signIn))).getResponse())
      .toMatchObject({ code: 'OTP_INVALID' });
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx jest src/modules/accounts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement**

`src/modules/accounts/email-sender.ts`:

```ts
import { Logger } from '@nestjs/common';
import { createTransport } from 'nodemailer';

import type { EmailConfig } from '../../config';

export const EMAIL_SENDER = Symbol('EMAIL_SENDER');

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** Development only: prints the message (and so the code) in the server log. Refused in production. */
export class LogEmailSender implements EmailSender {
  private readonly logger = new Logger('Email');

  async send(message: EmailMessage): Promise<void> {
    this.logger.log(`[development email] to ${message.to} — ${message.subject}: ${message.text}`);
  }
}

interface MailTransport {
  sendMail(mail: EmailMessage & { from: string }): Promise<unknown>;
}

export class SmtpEmailSender implements EmailSender {
  constructor(
    private readonly transport: MailTransport,
    private readonly from: string,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...message });
  }
}

export function createEmailSender(cfg: EmailConfig): EmailSender {
  if (cfg.sender !== 'smtp') return new LogEmailSender();
  const { host, port, secure, user, password } = cfg.smtp;
  return new SmtpEmailSender(
    createTransport({ host, port, secure, ...(user ? { auth: { user, pass: password } } : {}) }),
    cfg.from,
  );
}
```

`src/modules/accounts/otp.service.ts`:

```ts
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { randomInt, timingSafeEqual } from 'node:crypto';

import { REDIS } from '../../core/cache/cache.service';
import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { IdentityHashService } from '../../core/identity/identity-hash.service';
import { RateLimiter } from '../../core/rate-limit/rate-limiter';
import { CreditSettingsService } from '../credits/credit-settings.service';
import { EMAIL_SENDER, type EmailSender } from './email-sender';

export type OtpPurpose = 'sign_in' | 'delete_account';
export const OTP_TTL_SECONDS = 600;
const HOUR = 3_600;

const MESSAGES: Record<OtpPurpose, { subject: string; text: (code: string) => string }> = {
  sign_in: {
    subject: 'Your SlimShot sign-in code',
    text: (code) =>
      `Your SlimShot code is ${code}. It expires in 10 minutes.\n\nIf you did not try to sign in, ignore this email.`,
  },
  delete_account: {
    subject: 'Confirm deleting your SlimShot account',
    text: (code) =>
      `Enter ${code} to confirm deleting your SlimShot account. It expires in 10 minutes.\n\nIf you did not ask for this, ignore this email; nothing will be deleted.`,
  },
};

/** 6-digit email codes. Redis holds only an HMAC of each code and an attempts counter. */
@Injectable()
export class OtpService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly hashes: IdentityHashService,
    private readonly settings: CreditSettingsService,
    private readonly limiter: RateLimiter,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
  ) {}

  async send(
    purpose: OtpPurpose,
    email: string,
    scope: { installId?: string; ip?: string },
  ): Promise<{ resendAfterSeconds: number; expiresInSeconds: number }> {
    const s = await this.settings.get();
    const who = this.hashes.hash('email', email);
    const cooldownKey = `otp:cooldown:${purpose}:${who}`;

    const wait = await this.redis.ttl(cooldownKey);
    if (wait > 0) {
      throw appError(HttpStatus.TOO_MANY_REQUESTS, ErrorCode.OTP_RESEND_TOO_SOON, 'Wait before asking for another code.', {
        retryAfterSeconds: wait,
      });
    }
    await this.limiter.hit(`otp:email:${who}`, s.otpPerEmailPerHour, HOUR);
    if (scope.installId) await this.limiter.hit(`otp:install:${scope.installId}`, s.otpPerDevicePerHour, HOUR);
    if (scope.ip) await this.limiter.hit(`otp:ip:${this.hashes.hash('ip', scope.ip)}`, s.otpPerIpPerHour, HOUR);

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.redis.set(this.codeKey(purpose, who), this.codeHash(purpose, email, code), 'EX', OTP_TTL_SECONDS);
    await this.redis.set(this.attemptsKey(purpose, who), '0', 'EX', OTP_TTL_SECONDS);
    if (s.otpResendCooldownSeconds > 0) await this.redis.set(cooldownKey, '1', 'EX', s.otpResendCooldownSeconds);

    const message = MESSAGES[purpose];
    await this.email.send({ to: email, subject: message.subject, text: message.text(code) });
    return { resendAfterSeconds: s.otpResendCooldownSeconds, expiresInSeconds: OTP_TTL_SECONDS };
  }

  async verify(purpose: OtpPurpose, email: string, code: string): Promise<void> {
    const s = await this.settings.get();
    const who = this.hashes.hash('email', email);
    const codeKey = this.codeKey(purpose, who);
    const attemptsKey = this.attemptsKey(purpose, who);

    const stored = await this.redis.get(codeKey);
    if (!stored) {
      throw appError(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.OTP_EXPIRED, 'This code has expired. Request a new one.');
    }
    // Counted atomically before comparing, so parallel guesses cannot exceed the budget.
    const attempts = await this.redis.incr(attemptsKey);
    if (attempts <= s.otpMaxAttempts && this.matches(stored, this.codeHash(purpose, email, code))) {
      await this.redis.del(codeKey, attemptsKey);
      return;
    }
    if (attempts >= s.otpMaxAttempts) {
      await this.redis.del(codeKey, attemptsKey);
      throw appError(HttpStatus.TOO_MANY_REQUESTS, ErrorCode.OTP_ATTEMPTS_EXCEEDED, 'Too many wrong codes. Request a new one.');
    }
    throw appError(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.OTP_INVALID, 'That code is not right.', {
      attemptsLeft: s.otpMaxAttempts - attempts,
    });
  }

  private codeKey(purpose: OtpPurpose, who: string): string {
    return `otp:code:${purpose}:${who}`;
  }

  private attemptsKey(purpose: OtpPurpose, who: string): string {
    return `otp:attempts:${purpose}:${who}`;
  }

  private codeHash(purpose: OtpPurpose, email: string, code: string): string {
    return this.hashes.hash('otp', `${purpose}:${email}:${code}`);
  }

  private matches(a: string, b: string): boolean {
    return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `npx jest src/modules/accounts && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/modules/accounts
git commit -m "feat: email sender and one-time sign-in codes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Google verification, usernames, referral codes, disposable domains

**Files:**
- Create: `src/modules/accounts/google-verifier.ts`, `src/modules/accounts/username.ts`, `src/modules/accounts/referral-code.ts`, `src/modules/accounts/email-domain.ts`
- Test: `src/modules/accounts/google-verifier.spec.ts`, `src/modules/accounts/username.spec.ts`, `src/modules/accounts/referral-code.spec.ts`, `src/modules/accounts/email-domain.spec.ts`

**Interfaces:**
- Produces:
  - `GOOGLE_OAUTH` token; `GoogleVerifier.verify(idToken: string): Promise<{ sub: string; email: string }>` (email normalised)
  - `normalizeUsername(raw: string): string`, `usernameProblem(name: string): 'INVALID' | 'RESERVED' | null`, `RESERVED_USERNAMES`
  - `newReferralCode(): string` (8 chars), `normalizeReferralCode(raw: string): string`
  - `isDisposable(email: string, domains: string[]): boolean`

- [ ] **Step 1: Install google-auth-library**

Run: `npm install google-auth-library@^11.1.0`

- [ ] **Step 2: Write the failing tests**

`src/modules/accounts/google-verifier.spec.ts`:

```ts
import { HttpException } from '@nestjs/common';

import { GoogleVerifier } from './google-verifier';

const ticket = (payload: Record<string, unknown>) => ({ getPayload: () => payload });

function build(ids = ['web-1.apps.googleusercontent.com']) {
  const client = { verifyIdToken: jest.fn() };
  return { client, verifier: new GoogleVerifier({ googleClientIds: ids } as never, client as never) };
}

async function errorOf(p: Promise<unknown>): Promise<HttpException> {
  return p.then(() => {
    throw new Error('expected a failure');
  }, (e: HttpException) => e);
}

describe('GoogleVerifier', () => {
  it('checks the token against our client IDs and returns the Google ID and email', async () => {
    const { client, verifier } = build();
    client.verifyIdToken.mockResolvedValue(ticket({ sub: 'g-123', email: 'Ann@Gmail.com', email_verified: true }));
    await expect(verifier.verify('id-token')).resolves.toEqual({ sub: 'g-123', email: 'ann@gmail.com' });
    expect(client.verifyIdToken).toHaveBeenCalledWith({
      idToken: 'id-token',
      audience: ['web-1.apps.googleusercontent.com'],
    });
  });

  it('answers 503 when Google sign-in is not configured, without calling Google', async () => {
    const { client, verifier } = build([]);
    const error = await errorOf(verifier.verify('id-token'));
    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toMatchObject({ code: 'SIGN_IN_METHOD_UNAVAILABLE' });
    expect(client.verifyIdToken).not.toHaveBeenCalled();
  });

  it('answers 401 for a token Google does not vouch for', async () => {
    const { client, verifier } = build();
    client.verifyIdToken.mockRejectedValue(new Error('Wrong recipient, payload audience != requiredAudience'));
    const error = await errorOf(verifier.verify('id-token'));
    expect(error.getStatus()).toBe(401);
    expect(error.getResponse()).toMatchObject({ code: 'GOOGLE_TOKEN_INVALID' });
  });

  it.each([
    { sub: 'g-1', email: 'ann@gmail.com', email_verified: false },
    { sub: 'g-1' },
  ])('answers 422 without a verified email: %j', async (payload) => {
    const { client, verifier } = build();
    client.verifyIdToken.mockResolvedValue(ticket(payload));
    const error = await errorOf(verifier.verify('id-token'));
    expect(error.getStatus()).toBe(422);
    expect(error.getResponse()).toMatchObject({ code: 'GOOGLE_EMAIL_UNVERIFIED' });
  });
});
```

`src/modules/accounts/username.spec.ts`:

```ts
import { normalizeUsername, usernameProblem } from './username';

describe('usernames', () => {
  it('trims and lowercases what the user typed', () => {
    expect(normalizeUsername('  Ann_1 ')).toBe('ann_1');
  });

  it.each([
    ['ann_1', null],
    ['abc', null],
    ['a'.repeat(20), null],
    ['ab', 'INVALID'],
    ['a'.repeat(21), 'INVALID'],
    ['ann-1', 'INVALID'],
    ['ann 1', 'INVALID'],
    ['admin', 'RESERVED'],
    ['slimshot', 'RESERVED'],
  ])('%s → %s', (name, problem) => {
    expect(usernameProblem(name)).toBe(problem);
  });
});
```

`src/modules/accounts/referral-code.spec.ts`:

```ts
import { newReferralCode, normalizeReferralCode } from './referral-code';

describe('referral codes', () => {
  it('are 8 unambiguous characters and do not repeat', () => {
    const codes = new Set(Array.from({ length: 200 }, () => newReferralCode()));
    expect(codes.size).toBe(200);
    for (const code of codes) expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{8}$/);
  });

  it('accept any case and stray spaces', () => {
    expect(normalizeReferralCode(' ab3d ef7k ')).toBe('AB3DEF7K');
  });
});
```

`src/modules/accounts/email-domain.spec.ts`:

```ts
import { isDisposable } from './email-domain';

describe('isDisposable', () => {
  const list = ['mailinator.com', 'yopmail.com'];

  it.each([
    ['x@mailinator.com', true],
    ['x@eu.mailinator.com', true],
    ['x@YOPMAIL.com', true],
    ['x@gmail.com', false],
    ['x@notmailinator.com', false],
  ])('%s → %s', (email, expected) => {
    expect(isDisposable(email, list)).toBe(expected);
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx jest src/modules/accounts/google-verifier.spec.ts src/modules/accounts/username.spec.ts src/modules/accounts/referral-code.spec.ts src/modules/accounts/email-domain.spec.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement**

`src/modules/accounts/google-verifier.ts`:

```ts
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { OAuth2Client, TokenPayload } from 'google-auth-library';

import { appAuthConfig, type AppAuthConfig } from '../../config';
import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { normalizeEmail } from '../../core/identity/email';

export const GOOGLE_OAUTH = Symbol('GOOGLE_OAUTH');

/**
 * Checks a Google ID token from the app's account picker: signed by Google,
 * issued for our Web client ID, not expired, with a verified email.
 */
@Injectable()
export class GoogleVerifier {
  constructor(
    @Inject(appAuthConfig.KEY) private readonly cfg: AppAuthConfig,
    @Inject(GOOGLE_OAUTH) private readonly client: Pick<OAuth2Client, 'verifyIdToken'>,
  ) {}

  async verify(idToken: string): Promise<{ sub: string; email: string }> {
    if (this.cfg.googleClientIds.length === 0) {
      throw appError(HttpStatus.SERVICE_UNAVAILABLE, ErrorCode.SIGN_IN_METHOD_UNAVAILABLE, 'Google sign-in is not set up on the server.');
    }
    let payload: TokenPayload | undefined;
    try {
      payload = (await this.client.verifyIdToken({ idToken, audience: this.cfg.googleClientIds })).getPayload();
    } catch {
      payload = undefined;
    }
    if (!payload?.sub) {
      throw appError(HttpStatus.UNAUTHORIZED, ErrorCode.GOOGLE_TOKEN_INVALID, 'Google sign-in could not be verified. Try again.');
    }
    if (!payload.email || payload.email_verified !== true) {
      throw appError(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.GOOGLE_EMAIL_UNVERIFIED, 'This Google account has no verified email.');
    }
    return { sub: payload.sub, email: normalizeEmail(payload.email) };
  }
}
```

`src/modules/accounts/username.ts`:

```ts
export const RESERVED_USERNAMES = new Set([
  'account', 'admin', 'administrator', 'api', 'billing', 'credits', 'help', 'me', 'mod', 'moderator',
  'null', 'official', 'root', 'security', 'settings', 'slimshot', 'slimshotai', 'staff', 'support',
  'system', 'team', 'undefined',
]);

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

/** For a normalised name: why it cannot be used, or null. */
export function usernameProblem(name: string): 'INVALID' | 'RESERVED' | null {
  if (!/^[a-z0-9_]{3,20}$/.test(name)) return 'INVALID';
  if (RESERVED_USERNAMES.has(name)) return 'RESERVED';
  return null;
}
```

`src/modules/accounts/referral-code.ts`:

```ts
import { randomInt } from 'node:crypto';

// Crockford-style: no I, L, O, U, 0 or 1, so a code read aloud cannot be misheard.
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

export function newReferralCode(): string {
  return Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
}

export function normalizeReferralCode(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}
```

`src/modules/accounts/email-domain.ts`:

```ts
import { emailDomain } from '../../core/identity/email';

/** True for a listed disposable domain or any subdomain of one. */
export function isDisposable(email: string, domains: string[]): boolean {
  const domain = emailDomain(email);
  return domains.some((d) => domain === d || domain.endsWith(`.${d}`));
}
```

- [ ] **Step 5: Run the tests**

Run: `npx jest src/modules/accounts && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/modules/accounts
git commit -m "feat: Google token verification, username and referral-code rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: User tokens and the sign-in guard

**Files:**
- Create: `src/modules/accounts/user-tokens.service.ts`, `src/modules/accounts/user-auth.guard.ts`, `src/modules/accounts/current-app-user.decorator.ts`
- Test: `src/modules/accounts/user-tokens.service.spec.ts`, `src/modules/accounts/user-auth.guard.spec.ts`

**Interfaces:**
- Produces:
  - `interface AppTokenPair { accessToken: string; refreshToken: string; expiresIn: number }`
  - `interface AppUserClaims { sub: string; sid: string }`
  - `interface AuthenticatedAppUser { id: string; sessionId: string; deviceId: string; status: AccountStatus }`
  - `UserTokensService.startSession(userId, deviceId): Promise<AppTokenPair>`, `.rotate(refreshToken): Promise<AppTokenPair>`, `.logout(refreshToken): Promise<void>`, `.revokeSession(sessionId): Promise<void>`, `.verifyAccess(token): Promise<AppUserClaims>`
  - `UserAuthGuard` (sets `req.appUser`), `@CurrentAppUser()` decorator
  - `APP_TOKEN_AUDIENCE = 'slimshot-app'`

- [ ] **Step 1: Write the failing tests**

`src/modules/accounts/user-tokens.service.spec.ts`:

```ts
import { HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { UserTokensService } from './user-tokens.service';

interface Session { id: string; userId: string; deviceId: string; revokedAt: Date | null; lastUsedAt: Date }
interface Token { id: string; tokenHash: string; sessionId: string; expiresAt: Date; revokedAt: Date | null }

function build() {
  const sessions = new Map<string, Session>();
  const tokens = new Map<string, Token>();
  const users = new Map([['u1', { id: 'u1', accountStatus: 'active' }]]);
  let seq = 0;
  const matchToken = (t: Token, where: Record<string, unknown>) =>
    (where.id === undefined || t.id === where.id) &&
    (where.sessionId === undefined || t.sessionId === where.sessionId) &&
    (where.revokedAt !== null || t.revokedAt === null);
  const prisma = {
    userSession: {
      create: jest.fn(async ({ data }: { data: { userId: string; deviceId: string } }) => {
        const s: Session = { id: `s${(seq += 1)}`, revokedAt: null, lastUsedAt: new Date(), ...data };
        sessions.set(s.id, s);
        return { id: s.id };
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Session> }) =>
        Object.assign(sessions.get(where.id) as Session, data),
      ),
      updateMany: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Session> }) => {
        const s = sessions.get(where.id);
        if (!s || s.revokedAt) return { count: 0 };
        Object.assign(s, data);
        return { count: 1 };
      }),
    },
    userRefreshToken: {
      create: jest.fn(async ({ data }: { data: Omit<Token, 'id' | 'revokedAt'> }) => {
        const t: Token = { id: `t${(seq += 1)}`, revokedAt: null, ...data };
        tokens.set(t.tokenHash, t);
        return t;
      }),
      findUnique: jest.fn(async ({ where }: { where: { tokenHash: string } }) => {
        const t = tokens.get(where.tokenHash);
        if (!t) return null;
        const s = sessions.get(t.sessionId) as Session;
        return { ...t, session: { ...s, user: users.get(s.userId) } };
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Token> }) => {
        let count = 0;
        for (const t of tokens.values()) if (matchToken(t, where)) {
          Object.assign(t, data);
          count += 1;
        }
        return { count };
      }),
    },
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const svc = new UserTokensService(
    prisma as never,
    { jwtSecret: 'u'.repeat(48), accessTtlSeconds: 900, refreshTtlSeconds: 2_592_000 } as never,
    new JwtService({}),
  );
  return { svc, sessions, tokens, users };
}

async function errorOf(p: Promise<unknown>): Promise<HttpException> {
  return p.then(() => {
    throw new Error('expected a failure');
  }, (e: HttpException) => e);
}

describe('UserTokensService', () => {
  it('starts a session with an app access token and a hashed refresh token', async () => {
    const { svc, tokens } = build();
    const pair = await svc.startSession('u1', 'dev-1');
    expect(pair.expiresIn).toBe(900);
    await expect(svc.verifyAccess(pair.accessToken)).resolves.toMatchObject({ sub: 'u1', sid: 's1' });
    expect([...tokens.keys()]).not.toContain(pair.refreshToken);
  });

  it('rejects tokens signed with another secret or for another audience', async () => {
    const { svc } = build();
    const jwt = new JwtService({});
    const adminLike = await jwt.signAsync({ sub: 'u1', sid: 's1' }, { secret: 's'.repeat(48), audience: 'slimshot-app' });
    const noAudience = await jwt.signAsync({ sub: 'u1', sid: 's1' }, { secret: 'u'.repeat(48) });
    for (const token of [adminLike, noAudience]) {
      expect((await errorOf(svc.verifyAccess(token))).getResponse()).toMatchObject({ code: 'UNAUTHENTICATED' });
    }
  });

  it('rotates a refresh token and refuses the old one afterwards, ending the session', async () => {
    const { svc, sessions } = build();
    const first = await svc.startSession('u1', 'dev-1');
    const second = await svc.rotate(first.refreshToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);

    const reuse = await errorOf(svc.rotate(first.refreshToken));
    expect(reuse.getStatus()).toBe(401);
    expect(sessions.get('s1')?.revokedAt).not.toBeNull();
    await expect(svc.rotate(second.refreshToken)).rejects.toBeInstanceOf(HttpException);
  });

  it('lets only one of two simultaneous refreshes through', async () => {
    const { svc } = build();
    const pair = await svc.startSession('u1', 'dev-1');
    const results = await Promise.allSettled([svc.rotate(pair.refreshToken), svc.rotate(pair.refreshToken)]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeLessThanOrEqual(1);
  });

  it('refuses an expired refresh token', async () => {
    const { svc, tokens } = build();
    const pair = await svc.startSession('u1', 'dev-1');
    for (const t of tokens.values()) t.expiresAt = new Date(Date.now() - 1);
    expect((await errorOf(svc.rotate(pair.refreshToken))).getStatus()).toBe(401);
  });

  it("refuses a deleted user's refresh token", async () => {
    const { svc, users } = build();
    const pair = await svc.startSession('u1', 'dev-1');
    users.set('u1', { id: 'u1', accountStatus: 'deleted' });
    expect((await errorOf(svc.rotate(pair.refreshToken))).getStatus()).toBe(401);
  });

  it('logs out by ending the session; an unknown token is ignored', async () => {
    const { svc, sessions } = build();
    const pair = await svc.startSession('u1', 'dev-1');
    await svc.logout(pair.refreshToken);
    expect(sessions.get('s1')?.revokedAt).not.toBeNull();
    await expect(svc.logout('unknown-token-value-0000')).resolves.toBeUndefined();
  });
});
```

`src/modules/accounts/user-auth.guard.spec.ts`:

```ts
import { ExecutionContext, HttpException } from '@nestjs/common';

import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { UserAuthGuard } from './user-auth.guard';

const JWT = 'aaa.bbb.ccc';

function contextWith(authorization?: string) {
  const req: { headers: Record<string, string | undefined>; appUser?: unknown } = { headers: { authorization } };
  return { req, ctx: { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext };
}

function build(session: Record<string, unknown> | null = {
  id: 's1', revokedAt: null, deviceId: 'dev-1', user: { id: 'u1', accountStatus: 'active' },
}) {
  const tokens = { verifyAccess: jest.fn(async () => ({ sub: 'u1', sid: 's1' })) };
  const prisma = { userSession: { findUnique: jest.fn(async () => session) } };
  return { tokens, guard: new UserAuthGuard(tokens as never, prisma as never) };
}

async function codeOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(() => 'passed', (e: HttpException) => (e.getResponse() as { code: string }).code);
}

describe('UserAuthGuard', () => {
  it.each([undefined, 'Basic abc', 'Bearer', 'Bearer device-token-without-dots'])(
    'asks the user to sign in for %p',
    async (header) => {
      const { guard } = build();
      await expect(codeOf(guard.canActivate(contextWith(header).ctx))).resolves.toBe('SIGN_IN_REQUIRED');
    },
  );

  it('passes on an invalid or expired access token as UNAUTHENTICATED', async () => {
    const { guard, tokens } = build();
    tokens.verifyAccess.mockRejectedValue(appError(401, ErrorCode.UNAUTHENTICATED, 'Invalid or expired access token.'));
    await expect(codeOf(guard.canActivate(contextWith(`Bearer ${JWT}`).ctx))).resolves.toBe('UNAUTHENTICATED');
  });

  it.each([
    null,
    { id: 's1', revokedAt: new Date(), deviceId: 'dev-1', user: { id: 'u1', accountStatus: 'active' } },
    { id: 's1', revokedAt: null, deviceId: 'dev-1', user: { id: 'u1', accountStatus: 'deleted' } },
    { id: 's1', revokedAt: null, deviceId: 'dev-1', user: { id: 'someone-else', accountStatus: 'active' } },
  ])('ends a session that is gone, revoked, deleted or not theirs: %j', async (session) => {
    const { guard } = build(session);
    await expect(codeOf(guard.canActivate(contextWith(`Bearer ${JWT}`).ctx))).resolves.toBe('UNAUTHENTICATED');
  });

  it('attaches the user, including a suspended one', async () => {
    const { guard } = build({ id: 's1', revokedAt: null, deviceId: 'dev-1', user: { id: 'u1', accountStatus: 'suspended' } });
    const { req, ctx } = contextWith(`Bearer ${JWT}`);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.appUser).toEqual({ id: 'u1', sessionId: 's1', deviceId: 'dev-1', status: 'suspended' });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx jest src/modules/accounts/user-tokens.service.spec.ts src/modules/accounts/user-auth.guard.spec.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/modules/accounts/user-tokens.service.ts`:

```ts
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';

import { appAuthConfig, type AppAuthConfig } from '../../config';
import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { AccountStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';

export const APP_TOKEN_AUDIENCE = 'slimshot-app';

export interface AppTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AppUserClaims {
  sub: string;
  sid: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function unauthenticated(message: string) {
  return appError(HttpStatus.UNAUTHORIZED, ErrorCode.UNAUTHENTICATED, message);
}

/** App-user tokens: their own secret and audience, never accepted by admin routes (or vice versa). */
@Injectable()
export class UserTokensService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(appAuthConfig.KEY) private readonly cfg: AppAuthConfig,
    private readonly jwt: JwtService,
  ) {}

  async startSession(userId: string, deviceId: string): Promise<AppTokenPair> {
    const session = await this.prisma.userSession.create({ data: { userId, deviceId }, select: { id: true } });
    return this.issue(userId, session.id);
  }

  async rotate(presented: string): Promise<AppTokenPair> {
    const row = await this.prisma.userRefreshToken.findUnique({
      where: { tokenHash: sha256(presented) },
      include: { session: { include: { user: { select: { accountStatus: true } } } } },
    });
    if (!row) throw unauthenticated('Invalid refresh token.');

    if (row.revokedAt || row.session.revokedAt) {
      // A rotated token came back: someone else holds a copy. End the whole session.
      await this.revokeSession(row.sessionId);
      throw unauthenticated('This session has ended. Sign in again.');
    }
    if (row.expiresAt.getTime() <= Date.now()) throw unauthenticated('Refresh token expired. Sign in again.');
    if (row.session.user.accountStatus === AccountStatus.deleted) {
      await this.revokeSession(row.sessionId);
      throw unauthenticated('This account no longer exists.');
    }

    // Claim the token atomically: of two simultaneous refreshes, only one rotates.
    const claimed = await this.prisma.userRefreshToken.updateMany({
      where: { id: row.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (claimed.count === 0) {
      await this.revokeSession(row.sessionId);
      throw unauthenticated('This session has ended. Sign in again.');
    }
    await this.prisma.userSession.update({ where: { id: row.sessionId }, data: { lastUsedAt: new Date() } });
    return this.issue(row.session.userId, row.sessionId);
  }

  async logout(presented: string): Promise<void> {
    const row = await this.prisma.userRefreshToken.findUnique({ where: { tokenHash: sha256(presented) } });
    if (row) await this.revokeSession(row.sessionId);
  }

  async revokeSession(sessionId: string): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.userSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: now } }),
      this.prisma.userRefreshToken.updateMany({ where: { sessionId, revokedAt: null }, data: { revokedAt: now } }),
    ]);
  }

  async verifyAccess(token: string): Promise<AppUserClaims> {
    try {
      return await this.jwt.verifyAsync<AppUserClaims>(token, {
        secret: this.cfg.jwtSecret,
        audience: APP_TOKEN_AUDIENCE,
      });
    } catch {
      throw unauthenticated('Invalid or expired access token.');
    }
  }

  private async issue(userId: string, sessionId: string): Promise<AppTokenPair> {
    const accessToken = await this.jwt.signAsync(
      { sub: userId, sid: sessionId },
      { secret: this.cfg.jwtSecret, expiresIn: this.cfg.accessTtlSeconds, audience: APP_TOKEN_AUDIENCE },
    );
    const refreshToken = randomBytes(48).toString('base64url');
    await this.prisma.userRefreshToken.create({
      data: {
        tokenHash: sha256(refreshToken),
        sessionId,
        expiresAt: new Date(Date.now() + this.cfg.refreshTtlSeconds * 1000),
      },
    });
    return { accessToken, refreshToken, expiresIn: this.cfg.accessTtlSeconds };
  }
}
```

`src/modules/accounts/user-auth.guard.ts`:

```ts
import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';

import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { AccountStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { UserTokensService } from './user-tokens.service';

export interface AuthenticatedAppUser {
  id: string;
  sessionId: string;
  deviceId: string;
  status: AccountStatus;
}

/**
 * App routes that need an account. No bearer, or a bearer that is not a JWT
 * (such as the old anonymous device token), means "sign in"; a bad or ended
 * session means "refresh or sign in again". Suspended users pass; paths that
 * spend check status themselves.
 */
@Injectable()
export class UserAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: UserTokensService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined>; appUser?: AuthenticatedAppUser }>();

    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token || token.split('.').length !== 3) {
      throw appError(HttpStatus.UNAUTHORIZED, ErrorCode.SIGN_IN_REQUIRED, 'Sign in to use this feature.');
    }

    const claims = await this.tokens.verifyAccess(token);
    const session = await this.prisma.userSession.findUnique({
      where: { id: claims.sid },
      select: { id: true, revokedAt: true, deviceId: true, user: { select: { id: true, accountStatus: true } } },
    });
    if (
      !session ||
      session.revokedAt ||
      session.user.id !== claims.sub ||
      session.user.accountStatus === AccountStatus.deleted
    ) {
      throw appError(HttpStatus.UNAUTHORIZED, ErrorCode.UNAUTHENTICATED, 'This session has ended. Sign in again.');
    }

    req.appUser = { id: session.user.id, sessionId: session.id, deviceId: session.deviceId, status: session.user.accountStatus };
    return true;
  }
}
```

`src/modules/accounts/current-app-user.decorator.ts`:

```ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import type { AuthenticatedAppUser } from './user-auth.guard';

export const CurrentAppUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedAppUser =>
    context.switchToHttp().getRequest<{ appUser: AuthenticatedAppUser }>().appUser,
);
```

- [ ] **Step 4: Run the tests**

Run: `npx jest src/modules/accounts && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/accounts
git commit -m "feat: app-user tokens with rotation and the sign-in guard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Sign-in endpoints

**Files:**
- Create: `src/modules/accounts/me.service.ts`, `src/modules/accounts/accounts.service.ts`, `src/modules/accounts/dto/sign-in.dto.ts`, `src/modules/accounts/app-auth.controller.ts`, `src/modules/accounts/accounts.module.ts`
- Modify: `src/app.module.ts` (import `AccountsModule`)
- Test: `src/modules/accounts/accounts.service.spec.ts`, `src/modules/accounts/me.service.spec.ts`, `src/modules/accounts/app-auth.http.spec.ts`

**Interfaces:**
- Consumes: `DevicesService.authenticate(token): Promise<{id} | null>`; Tasks 4–8.
- Produces:
  - `interface MeView { id: string; email: string | null; username: string | null; referralCode: string | null; creditBalance: number; accountStatus: AccountStatus; needsClaim: boolean; signInMethods: { google: boolean; email: boolean }; ads: { rewardCredits: number; dailyCap: number; remainingToday: number } }`
  - `MeService.view(userId: string, now?: Date): Promise<MeView>`
  - `interface SignInResponse extends AppTokenPair { isNewAccount: boolean; needsClaim: boolean; user: MeView }`
  - `AccountsService.startEmail(email, deviceToken, ip?)`, `.verifyEmail(email, code, deviceToken, ip?)`, `.signInWithGoogle(idToken, deviceToken, ip?)`, `.refresh(token)`, `.logout(token)`
  - `AccountsModule` exports `UserTokensService`, `UserAuthGuard`, `MeService`, `OtpService`
  - Routes: `POST /api/app/v1/auth/google | email/start | email/verify | refresh | logout` (all 200)

- [ ] **Step 1: Write the failing tests**

`src/modules/accounts/me.service.spec.ts`:

```ts
import { MeService } from './me.service';

describe('MeService.view', () => {
  it('describes the account, sign-in methods and ads left today', async () => {
    const prisma = {
      user: {
        findUniqueOrThrow: jest.fn(async () => ({
          id: 'u1', email: 'ann@example.com', username: null, referralCode: 'AB3DEF7K', creditBalance: 40,
          accountStatus: 'active', claimedAt: null, googleSub: 'g-1',
        })),
      },
      creditTransaction: { count: jest.fn(async () => 3) },
    };
    const settings = { get: jest.fn(async () => ({ adRewardCredits: 5, adDailyCap: 10 })) };
    const me = new MeService(prisma as never, settings as never);

    await expect(me.view('u1', new Date('2026-10-03T12:00:00Z'))).resolves.toEqual({
      id: 'u1',
      email: 'ann@example.com',
      username: null,
      referralCode: 'AB3DEF7K',
      creditBalance: 40,
      accountStatus: 'active',
      needsClaim: true,
      signInMethods: { google: true, email: true },
      ads: { rewardCredits: 5, dailyCap: 10, remainingToday: 7 },
    });
  });
});
```

`src/modules/accounts/accounts.service.spec.ts`:

```ts
import { HttpException } from '@nestjs/common';

import { FakeRedis } from '../../../test/fakes/fake-redis';
import { IdentityHashService } from '../../core/identity/identity-hash.service';
import { RateLimiter } from '../../core/rate-limit/rate-limiter';
import { AccountsService } from './accounts.service';

interface Row { id: string; email: string | null; googleSub: string | null; claimedAt: Date | null; signupIpLimited?: boolean; referralCode?: string }

function build(rows: Row[] = [], opts: { ipLimit?: number } = {}) {
  let seq = rows.length;
  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where }: { where: { email?: string; googleSub?: string } }) =>
        rows.find((r) => (where.email !== undefined ? r.email === where.email : r.googleSub === where.googleSub)) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: Omit<Row, 'id' | 'claimedAt'> }) => {
        const row: Row = { id: `u${(seq += 1)}`, claimedAt: null, googleSub: null, ...data };
        rows.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) =>
        Object.assign(rows.find((r) => r.id === where.id) as Row, data),
      ),
    },
    device: { update: jest.fn(async () => undefined) },
  };
  const devices = { authenticate: jest.fn(async (t: string) => (t === 'device-token-good-000000' ? { id: 'dev-1' } : null)) };
  const tokens = {
    startSession: jest.fn(async () => ({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 })),
    rotate: jest.fn(),
    logout: jest.fn(),
  };
  const otp = { send: jest.fn(async () => ({ resendAfterSeconds: 60, expiresInSeconds: 600 })), verify: jest.fn(async () => undefined) };
  const google = { verify: jest.fn(async () => ({ sub: 'g-1', email: 'ann@gmail.com' })) };
  const settings = {
    get: jest.fn(async () => ({ disposableEmailDomains: ['mailinator.com'], ipSignupLimitPer24h: opts.ipLimit ?? 10 })),
  };
  const redis = new FakeRedis();
  const hashes = new IdentityHashService({ identityHmacSecret: 'h'.repeat(48) } as never);
  const me = { view: jest.fn(async (id: string) => ({ id })) };
  const svc = new AccountsService(
    prisma as never, devices as never, tokens as never, otp as never, google as never,
    settings as never, new RateLimiter(redis as never), hashes, me as never,
  );
  return { svc, rows, prisma, tokens, otp, google };
}

const DEVICE = 'device-token-good-000000';

async function codeOf(p: Promise<unknown>): Promise<string> {
  return p.then(() => 'passed', (e: HttpException) => (e.getResponse() as { code: string }).code);
}

describe('AccountsService — Google', () => {
  it('creates an account for a new Google user and links the install', async () => {
    const { svc, rows, prisma, tokens } = build();
    const res = await svc.signInWithGoogle('id-token', DEVICE, '10.0.0.1');
    expect(res).toMatchObject({ isNewAccount: true, needsClaim: true, accessToken: 'a', user: { id: 'u1' } });
    expect(rows[0]).toMatchObject({ email: 'ann@gmail.com', googleSub: 'g-1', signupIpLimited: false });
    expect(rows[0].referralCode).toMatch(/^[A-Z2-9]{8}$/);
    expect(prisma.device.update).toHaveBeenCalledWith({ where: { id: 'dev-1' }, data: { userId: 'u1' } });
    expect(tokens.startSession).toHaveBeenCalledWith('u1', 'dev-1');
  });

  it('signs an existing Google user back in', async () => {
    const { svc, prisma } = build([{ id: 'u9', email: 'ann@gmail.com', googleSub: 'g-1', claimedAt: new Date() }]);
    await expect(svc.signInWithGoogle('id-token', DEVICE)).resolves.toMatchObject({ isNewAccount: false, needsClaim: false });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('links Google to an existing email account', async () => {
    const { svc, rows } = build([{ id: 'u9', email: 'ann@gmail.com', googleSub: null, claimedAt: null }]);
    await svc.signInWithGoogle('id-token', DEVICE);
    expect(rows[0].googleSub).toBe('g-1');
  });

  it('refuses an email already linked to a different Google account', async () => {
    const { svc } = build([{ id: 'u9', email: 'ann@gmail.com', googleSub: 'g-OTHER', claimedAt: null }]);
    await expect(codeOf(svc.signInWithGoogle('id-token', DEVICE))).resolves.toBe('ACCOUNT_LINK_CONFLICT');
  });

  it('refuses an unregistered install before asking Google', async () => {
    const { svc, google } = build();
    await expect(codeOf(svc.signInWithGoogle('id-token', 'unknown-device-token-00'))).resolves.toBe('DEVICE_NOT_REGISTERED');
    expect(google.verify).not.toHaveBeenCalled();
  });

  it('ends a parallel sign-up for the same email on one account', async () => {
    const { svc, rows, prisma } = build();
    prisma.user.create.mockImplementationOnce(async () => {
      rows.push({ id: 'u7', email: 'ann@gmail.com', googleSub: 'g-1', claimedAt: null });
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    });
    await expect(svc.signInWithGoogle('id-token', DEVICE)).resolves.toMatchObject({ isNewAccount: false, user: { id: 'u7' } });
    expect(rows).toHaveLength(1);
  });
});

describe('AccountsService — email code', () => {
  it('sends a code scoped to the install and IP', async () => {
    const { svc, otp } = build();
    await expect(svc.startEmail(' Ann@Example.com ', DEVICE, '10.0.0.1')).resolves.toEqual({
      sentTo: 'ann@example.com',
      resendAfterSeconds: 60,
      expiresInSeconds: 600,
    });
    expect(otp.send).toHaveBeenCalledWith('sign_in', 'ann@example.com', { installId: 'dev-1', ip: '10.0.0.1' });
  });

  it('refuses a disposable address', async () => {
    const { svc, otp } = build();
    await expect(codeOf(svc.startEmail('x@mailinator.com', DEVICE))).resolves.toBe('EMAIL_DOMAIN_NOT_ALLOWED');
    expect(otp.send).not.toHaveBeenCalled();
  });

  it('creates the account once the code checks out', async () => {
    const { svc, rows, otp } = build();
    await expect(svc.verifyEmail('ann@example.com', '123456', DEVICE)).resolves.toMatchObject({ isNewAccount: true });
    expect(otp.verify).toHaveBeenCalledWith('sign_in', 'ann@example.com', '123456');
    expect(rows[0].email).toBe('ann@example.com');
  });

  it('creates nothing when the code is wrong', async () => {
    const { svc, rows, otp } = build();
    otp.verify.mockRejectedValue(new Error('OTP_INVALID'));
    await expect(svc.verifyEmail('ann@example.com', '000000', DEVICE)).rejects.toThrow('OTP_INVALID');
    expect(rows).toHaveLength(0);
  });

  it('marks accounts past the per-IP daily limit', async () => {
    const { svc, rows } = build([], { ipLimit: 2 });
    for (const n of [1, 2, 3]) await svc.verifyEmail(`p${n}@example.com`, '123456', DEVICE, '10.0.0.9');
    expect(rows.map((r) => r.signupIpLimited)).toEqual([false, false, true]);
  });
});
```

`src/modules/accounts/app-auth.http.spec.ts`:

```ts
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { configureHttp } from '../../app.setup';
import { AccountsService } from './accounts.service';
import { AppAuthController } from './app-auth.controller';

describe('app auth API over HTTP', () => {
  let app: INestApplication;
  let base: string;
  const accounts = {
    signInWithGoogle: jest.fn(async () => ({ accessToken: 'a', refreshToken: 'r', expiresIn: 900, isNewAccount: true, needsClaim: true, user: { id: 'u1' } })),
    startEmail: jest.fn(async () => ({ sentTo: 'ann@example.com', resendAfterSeconds: 60, expiresInSeconds: 600 })),
    verifyEmail: jest.fn(),
    refresh: jest.fn(async () => ({ accessToken: 'a2', refreshToken: 'r2', expiresIn: 900 })),
    logout: jest.fn(async () => undefined),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AppAuthController],
      providers: [{ provide: AccountsService, useValue: accounts }],
    }).compile();
    app = moduleRef.createNestApplication();
    configureHttp(app);
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/api/app/v1/auth`;
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (path: string, body: unknown) =>
    fetch(`${base}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const DEVICE = 'device-token-good-000000';

  it('signs in with Google: 200 with tokens', async () => {
    const res = await post('google', { idToken: 'x'.repeat(40), deviceToken: DEVICE });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ accessToken: 'a', isNewAccount: true });
  });

  it('starts an email sign-in with a lowercased address', async () => {
    const res = await post('email/start', { email: 'Ann@Example.com', deviceToken: DEVICE });
    expect(res.status).toBe(200);
    expect(accounts.startEmail).toHaveBeenCalledWith('ann@example.com', DEVICE, expect.any(String));
  });

  it.each([
    ['google', { idToken: 'x'.repeat(40) }],
    ['email/start', { email: 'not-an-email', deviceToken: DEVICE }],
    ['email/verify', { email: 'ann@example.com', code: '12a456', deviceToken: DEVICE }],
  ])('422s an invalid %s request', async (path, body) => {
    const res = await post(path, body);
    expect(res.status).toBe(422);
  });

  it('refreshes and logs out with 200', async () => {
    expect((await post('refresh', { refreshToken: 'r'.repeat(64) })).status).toBe(200);
    const out = await post('logout', { refreshToken: 'r'.repeat(64) });
    expect(out.status).toBe(200);
    expect((await out.json()).data).toEqual({ loggedOut: true });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx jest src/modules/accounts`
Expected: FAIL — `./me.service`, `./accounts.service`, `./app-auth.controller` not found.

- [ ] **Step 3: Implement**

`src/modules/accounts/me.service.ts`:

```ts
import { Injectable } from '@nestjs/common';

import { AccountStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { adsUsedToday } from '../credits/ad-allowance';
import { CreditSettingsService } from '../credits/credit-settings.service';

export interface MeView {
  id: string;
  email: string | null;
  username: string | null;
  referralCode: string | null;
  creditBalance: number;
  accountStatus: AccountStatus;
  needsClaim: boolean;
  signInMethods: { google: boolean; email: boolean };
  ads: { rewardCredits: number; dailyCap: number; remainingToday: number };
}

@Injectable()
export class MeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: CreditSettingsService,
  ) {}

  async view(userId: string, now = new Date()): Promise<MeView> {
    const [user, settings, adsToday] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          id: true, email: true, username: true, referralCode: true, creditBalance: true,
          accountStatus: true, claimedAt: true, googleSub: true,
        },
      }),
      this.settings.get(),
      adsUsedToday(this.prisma, userId, now),
    ]);
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      referralCode: user.referralCode,
      creditBalance: user.creditBalance,
      accountStatus: user.accountStatus,
      needsClaim: user.claimedAt === null,
      signInMethods: { google: user.googleSub !== null, email: user.email !== null },
      ads: {
        rewardCredits: settings.adRewardCredits,
        dailyCap: settings.adDailyCap,
        remainingToday: Math.max(0, settings.adDailyCap - adsToday),
      },
    };
  }
}
```

`src/modules/accounts/accounts.service.ts`:

```ts
import { HttpStatus, Injectable } from '@nestjs/common';

import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { isUniqueViolation } from '../../core/errors/prisma-errors';
import { normalizeEmail } from '../../core/identity/email';
import { IdentityHashService } from '../../core/identity/identity-hash.service';
import { RateLimiter } from '../../core/rate-limit/rate-limiter';
import { PrismaService } from '../../prisma/prisma.service';
import { CreditSettingsService } from '../credits/credit-settings.service';
import { DevicesService } from '../devices/devices.service';
import { isDisposable } from './email-domain';
import { GoogleVerifier } from './google-verifier';
import { MeService, type MeView } from './me.service';
import { OtpService } from './otp.service';
import { newReferralCode } from './referral-code';
import { type AppTokenPair, UserTokensService } from './user-tokens.service';

export interface SignInResponse extends AppTokenPair {
  isNewAccount: boolean;
  needsClaim: boolean;
  user: MeView;
}

const ACCOUNT = { id: true, googleSub: true, claimedAt: true } as const;
type AccountRow = { id: string; googleSub: string | null; claimedAt: Date | null };
const DAY = 86_400;

@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly devices: DevicesService,
    private readonly tokens: UserTokensService,
    private readonly otp: OtpService,
    private readonly google: GoogleVerifier,
    private readonly settings: CreditSettingsService,
    private readonly limiter: RateLimiter,
    private readonly hashes: IdentityHashService,
    private readonly me: MeService,
  ) {}

  async startEmail(rawEmail: string, deviceToken: string, ip?: string) {
    const email = normalizeEmail(rawEmail);
    const deviceId = await this.requireDevice(deviceToken);
    await this.assertAllowedDomain(email);
    const sent = await this.otp.send('sign_in', email, { installId: deviceId, ip });
    return { sentTo: email, ...sent };
  }

  async verifyEmail(rawEmail: string, code: string, deviceToken: string, ip?: string): Promise<SignInResponse> {
    const email = normalizeEmail(rawEmail);
    const deviceId = await this.requireDevice(deviceToken);
    await this.otp.verify('sign_in', email, code);
    const existing = await this.prisma.user.findUnique({ where: { email }, select: ACCOUNT });
    const { user, isNew } = existing ? { user: existing, isNew: false } : await this.create({ email }, ip);
    return this.finish(user, isNew, deviceId);
  }

  async signInWithGoogle(idToken: string, deviceToken: string, ip?: string): Promise<SignInResponse> {
    const deviceId = await this.requireDevice(deviceToken);
    const { sub, email } = await this.google.verify(idToken);
    await this.assertAllowedDomain(email);

    const bySub = await this.prisma.user.findUnique({ where: { googleSub: sub }, select: ACCOUNT });
    if (bySub) return this.finish(bySub, false, deviceId);

    const byEmail = await this.prisma.user.findUnique({ where: { email }, select: ACCOUNT });
    if (byEmail) {
      if (byEmail.googleSub && byEmail.googleSub !== sub) {
        throw appError(HttpStatus.CONFLICT, ErrorCode.ACCOUNT_LINK_CONFLICT, 'This email is linked to a different Google account.');
      }
      const linked = await this.prisma.user.update({ where: { id: byEmail.id }, data: { googleSub: sub }, select: ACCOUNT });
      return this.finish(linked, false, deviceId);
    }

    const { user, isNew } = await this.create({ email, googleSub: sub }, ip);
    return this.finish(user, isNew, deviceId);
  }

  refresh(refreshToken: string): Promise<AppTokenPair> {
    return this.tokens.rotate(refreshToken);
  }

  logout(refreshToken: string): Promise<void> {
    return this.tokens.logout(refreshToken);
  }

  private async create(data: { email: string; googleSub?: string }, ip?: string): Promise<{ user: AccountRow; isNew: boolean }> {
    const settings = await this.settings.get();
    const fromThisIp = ip ? await this.limiter.increment(`signup:ip:${this.hashes.hash('ip', ip)}`, DAY) : 0;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const user = await this.prisma.user.create({
          data: { ...data, referralCode: newReferralCode(), signupIpLimited: fromThisIp > settings.ipSignupLimitPer24h },
          select: ACCOUNT,
        });
        return { user, isNew: true };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Either a parallel sign-in just created this account, or the referral code collided.
        const existing = await this.prisma.user.findUnique({ where: { email: data.email }, select: ACCOUNT });
        if (existing) return { user: existing, isNew: false };
      }
    }
    throw new Error('Could not allocate a unique referral code.');
  }

  private async finish(user: AccountRow, isNew: boolean, deviceId: string): Promise<SignInResponse> {
    await this.prisma.device.update({ where: { id: deviceId }, data: { userId: user.id } });
    const pair = await this.tokens.startSession(user.id, deviceId);
    return { ...pair, isNewAccount: isNew, needsClaim: user.claimedAt === null, user: await this.me.view(user.id) };
  }

  private async requireDevice(deviceToken: string): Promise<string> {
    const device = deviceToken ? await this.devices.authenticate(deviceToken) : null;
    if (!device) {
      throw appError(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.DEVICE_NOT_REGISTERED, 'Register this install first (POST /devices), then sign in.');
    }
    return device.id;
  }

  private async assertAllowedDomain(email: string): Promise<void> {
    const { disposableEmailDomains } = await this.settings.get();
    if (isDisposable(email, disposableEmailDomains)) {
      throw appError(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.EMAIL_DOMAIN_NOT_ALLOWED, 'Disposable email addresses cannot be used. Use your regular email.');
    }
  }
}
```

`src/modules/accounts/dto/sign-in.dto.ts`:

```ts
import { Transform, TransformFnParams } from 'class-transformer';
import { IsEmail, IsString, Length, Matches, MaxLength } from 'class-validator';

const lower = ({ value }: TransformFnParams): unknown => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export class DeviceBoundDto {
  @IsString()
  @Length(20, 200)
  deviceToken!: string;
}

export class GoogleSignInDto extends DeviceBoundDto {
  @IsString()
  @Length(20, 4096)
  idToken!: string;
}

export class EmailStartDto extends DeviceBoundDto {
  @Transform(lower)
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class EmailVerifyDto extends EmailStartDto {
  @Matches(/^\d{6}$/, { message: 'code must be the 6 digits from the email' })
  code!: string;
}

export class AppRefreshDto {
  @IsString()
  @Length(20, 200)
  refreshToken!: string;
}
```

`src/modules/accounts/app-auth.controller.ts`:

```ts
import { Body, Controller, HttpCode, Ip, Post } from '@nestjs/common';

import { AccountsService } from './accounts.service';
import { AppRefreshDto, EmailStartDto, EmailVerifyDto, GoogleSignInDto } from './dto/sign-in.dto';

@Controller('api/app/v1/auth')
export class AppAuthController {
  constructor(private readonly accounts: AccountsService) {}

  @Post('google')
  @HttpCode(200)
  async google(@Body() dto: GoogleSignInDto, @Ip() ip: string) {
    return { success: true as const, data: await this.accounts.signInWithGoogle(dto.idToken, dto.deviceToken, ip) };
  }

  @Post('email/start')
  @HttpCode(200)
  async startEmail(@Body() dto: EmailStartDto, @Ip() ip: string) {
    return { success: true as const, data: await this.accounts.startEmail(dto.email, dto.deviceToken, ip) };
  }

  @Post('email/verify')
  @HttpCode(200)
  async verifyEmail(@Body() dto: EmailVerifyDto, @Ip() ip: string) {
    return { success: true as const, data: await this.accounts.verifyEmail(dto.email, dto.code, dto.deviceToken, ip) };
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() dto: AppRefreshDto) {
    return { success: true as const, data: await this.accounts.refresh(dto.refreshToken) };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Body() dto: AppRefreshDto) {
    await this.accounts.logout(dto.refreshToken);
    return { success: true as const, data: { loggedOut: true } };
  }
}
```

`src/modules/accounts/accounts.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { OAuth2Client } from 'google-auth-library';

import { emailConfig, type EmailConfig } from '../../config';
import { CreditSettingsModule } from '../credits/credit-settings.module';
import { DevicesModule } from '../devices/devices.module';
import { AccountsService } from './accounts.service';
import { AppAuthController } from './app-auth.controller';
import { createEmailSender, EMAIL_SENDER } from './email-sender';
import { GOOGLE_OAUTH, GoogleVerifier } from './google-verifier';
import { MeService } from './me.service';
import { OtpService } from './otp.service';
import { UserAuthGuard } from './user-auth.guard';
import { UserTokensService } from './user-tokens.service';

@Module({
  imports: [JwtModule.register({}), DevicesModule, CreditSettingsModule],
  controllers: [AppAuthController],
  providers: [
    AccountsService,
    MeService,
    OtpService,
    GoogleVerifier,
    UserTokensService,
    UserAuthGuard,
    { provide: GOOGLE_OAUTH, useFactory: () => new OAuth2Client() },
    { provide: EMAIL_SENDER, inject: [emailConfig.KEY], useFactory: (cfg: EmailConfig) => createEmailSender(cfg) },
  ],
  exports: [UserTokensService, UserAuthGuard, MeService, OtpService],
})
export class AccountsModule {}
```

In `src/app.module.ts`, import `AccountsModule` from `./modules/accounts/accounts.module` and add it to `imports` after `DevicesModule`.

- [ ] **Step 4: Run the tests**

Run: `npx jest src/modules/accounts && npm run lint && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/accounts src/app.module.ts
git commit -m "feat: sign in with Google or an emailed code

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: `/me`, usernames and the claim step (username only for now)

**Files:**
- Create: `src/modules/accounts/username.service.ts`, `src/modules/accounts/claim.service.ts`, `src/modules/accounts/dto/me.dto.ts`, `src/modules/accounts/me.controller.ts`
- Modify: `src/modules/accounts/accounts.module.ts` (controllers + providers)
- Test: `src/modules/accounts/username.service.spec.ts`, `src/modules/accounts/claim.service.spec.ts`

**Interfaces:**
- Consumes: `MeService`, `UserAuthGuard`, `CurrentAppUser`, `RateLimiter`, `normalizeUsername`, `usernameProblem`.
- Produces:
  - `type UsernameCheck = { username: string; available: true } | { username: string; available: false; reason: 'INVALID' | 'RESERVED' | 'TAKEN' }`
  - `UsernameService.check(raw, forUserId?)`, `.assertAvailable(raw, userId): Promise<string>`, `.change(userId, raw): Promise<string>`
  - `ClaimService.claim(user: AuthenticatedAppUser, dto: ClaimDto): Promise<ClaimResult>` — Milestone 1 returns `{ user, bonus: null, referral: null }`; Task 16 replaces the file.
  - `ClaimDto { username: string; referralCode?: string }`, `UsernameDto { username: string }`, `DeleteMeDto { confirm: 'DELETE' }`
  - Routes: `GET /me`, `GET /usernames/:name/availability`, `PATCH /me/username`, `POST /me/claim`

- [ ] **Step 1: Write the failing tests**

`src/modules/accounts/username.service.spec.ts`:

```ts
import { HttpException } from '@nestjs/common';

import { UsernameService } from './username.service';

function build(owners: Record<string, string> = { taken_1: 'u2' }) {
  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where }: { where: { username: string } }) =>
        owners[where.username] ? { id: owners[where.username] } : null,
      ),
      update: jest.fn(async () => undefined),
    },
  };
  return { prisma, svc: new UsernameService(prisma as never) };
}

describe('UsernameService', () => {
  it.each([
    ['  Ann_1 ', { username: 'ann_1', available: true }],
    ['ab', { username: 'ab', available: false, reason: 'INVALID' }],
    ['admin', { username: 'admin', available: false, reason: 'RESERVED' }],
    ['Taken_1', { username: 'taken_1', available: false, reason: 'TAKEN' }],
  ])('checks %j', async (raw, expected) => {
    await expect(build().svc.check(raw, 'u1')).resolves.toEqual(expected);
  });

  it('treats your own current username as available', async () => {
    await expect(build({ ann_1: 'u1' }).svc.check('ann_1', 'u1')).resolves.toMatchObject({ available: true });
  });

  it('changes the username, and maps a race on the unique index to USERNAME_TAKEN', async () => {
    const { svc, prisma } = build();
    await expect(svc.change('u1', 'Ann_2')).resolves.toBe('ann_2');
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { username: 'ann_2' } });

    prisma.user.update.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }));
    const error = (await svc.change('u1', 'ann_3').catch((e: unknown) => e)) as HttpException;
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toMatchObject({ code: 'USERNAME_TAKEN' });
  });
});
```

`src/modules/accounts/claim.service.spec.ts`:

```ts
import { HttpException } from '@nestjs/common';

import { ClaimService } from './claim.service';

const user = (status = 'active') => ({ id: 'u1', sessionId: 's1', deviceId: 'dev-1', status }) as never;

function build(claimedAt: Date | null = null) {
  const prisma = {
    user: {
      findUniqueOrThrow: jest.fn(async () => ({ claimedAt })),
      updateMany: jest.fn(async () => ({ count: claimedAt ? 0 : 1 })),
    },
  };
  const usernames = { assertAvailable: jest.fn(async (raw: string) => raw.trim().toLowerCase()) };
  const me = { view: jest.fn(async () => ({ id: 'u1', username: 'ann_1' })) };
  return { prisma, usernames, svc: new ClaimService(prisma as never, usernames as never, me as never) };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  return p.then(() => 'passed', (e: HttpException) => (e.getResponse() as { code: string }).code);
}

describe('ClaimService (milestone 1)', () => {
  it('sets the username and marks the account claimed', async () => {
    const { svc, prisma } = build();
    await expect(svc.claim(user(), { username: ' Ann_1 ' })).resolves.toEqual({
      user: { id: 'u1', username: 'ann_1' },
      bonus: null,
      referral: null,
    });
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'u1', claimedAt: null },
      data: { username: 'ann_1', claimedAt: expect.any(Date) },
    });
  });

  it('refuses a second claim', async () => {
    await expect(codeOf(build(new Date()).svc.claim(user(), { username: 'ann_1' }))).resolves.toBe('ALREADY_CLAIMED');
  });

  it('refuses a suspended account', async () => {
    await expect(codeOf(build().svc.claim(user('suspended'), { username: 'ann_1' }))).resolves.toBe('ACCOUNT_SUSPENDED');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx jest src/modules/accounts/username.service.spec.ts src/modules/accounts/claim.service.spec.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/modules/accounts/username.service.ts`:

```ts
import { HttpStatus, Injectable } from '@nestjs/common';

import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { isUniqueViolation } from '../../core/errors/prisma-errors';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizeUsername, usernameProblem } from './username';

export type UsernameCheck =
  | { username: string; available: true }
  | { username: string; available: false; reason: 'INVALID' | 'RESERVED' | 'TAKEN' };

const taken = () => appError(HttpStatus.CONFLICT, ErrorCode.USERNAME_TAKEN, 'That username is taken.');

@Injectable()
export class UsernameService {
  constructor(private readonly prisma: PrismaService) {}

  async check(raw: string, forUserId?: string): Promise<UsernameCheck> {
    const username = normalizeUsername(raw);
    const problem = usernameProblem(username);
    if (problem) return { username, available: false, reason: problem };
    const owner = await this.prisma.user.findUnique({ where: { username }, select: { id: true } });
    if (owner && owner.id !== forUserId) return { username, available: false, reason: 'TAKEN' };
    return { username, available: true };
  }

  async assertAvailable(raw: string, userId: string): Promise<string> {
    const result = await this.check(raw, userId);
    if (result.available) return result.username;
    if (result.reason === 'TAKEN') throw taken();
    throw appError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      ErrorCode.USERNAME_INVALID,
      result.reason === 'RESERVED' ? 'That username is reserved.' : 'Usernames are 3–20 characters: a–z, 0–9 and _.',
    );
  }

  async change(userId: string, raw: string): Promise<string> {
    const username = await this.assertAvailable(raw, userId);
    try {
      await this.prisma.user.update({ where: { id: userId }, data: { username } });
    } catch (err) {
      if (isUniqueViolation(err)) throw taken();
      throw err;
    }
    return username;
  }
}
```

`src/modules/accounts/claim.service.ts` (milestone 1; Task 16 replaces it):

```ts
import { HttpStatus, Injectable } from '@nestjs/common';

import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { isUniqueViolation } from '../../core/errors/prisma-errors';
import { AccountStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import type { ClaimDto } from './dto/me.dto';
import { MeService, type MeView } from './me.service';
import type { AuthenticatedAppUser } from './user-auth.guard';
import { UsernameService } from './username.service';

export interface ClaimResult {
  user: MeView;
  bonus: null;
  referral: null;
}

@Injectable()
export class ClaimService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usernames: UsernameService,
    private readonly me: MeService,
  ) {}

  async claim(appUser: AuthenticatedAppUser, dto: ClaimDto): Promise<ClaimResult> {
    if (appUser.status === AccountStatus.suspended) {
      throw appError(HttpStatus.FORBIDDEN, ErrorCode.ACCOUNT_SUSPENDED, 'This account is suspended. Contact support.');
    }
    const { claimedAt } = await this.prisma.user.findUniqueOrThrow({ where: { id: appUser.id }, select: { claimedAt: true } });
    if (claimedAt) throw appError(HttpStatus.CONFLICT, ErrorCode.ALREADY_CLAIMED, 'This account is already set up.');

    const username = await this.usernames.assertAvailable(dto.username, appUser.id);
    try {
      const done = await this.prisma.user.updateMany({
        where: { id: appUser.id, claimedAt: null },
        data: { username, claimedAt: new Date() },
      });
      if (done.count === 0) throw appError(HttpStatus.CONFLICT, ErrorCode.ALREADY_CLAIMED, 'This account is already set up.');
    } catch (err) {
      if (isUniqueViolation(err)) throw appError(HttpStatus.CONFLICT, ErrorCode.USERNAME_TAKEN, 'That username is taken.');
      throw err;
    }
    return { user: await this.me.view(appUser.id), bonus: null, referral: null };
  }
}
```

`src/modules/accounts/dto/me.dto.ts`:

```ts
import { Equals, IsOptional, IsString, MaxLength } from 'class-validator';

export class UsernameDto {
  @IsString()
  @MaxLength(40)
  username!: string;
}

export class ClaimDto extends UsernameDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  referralCode?: string;
}

export class DeleteMeDto {
  @Equals('DELETE', { message: 'Send {"confirm":"DELETE"} to delete the account.' })
  confirm!: 'DELETE';
}
```

`src/modules/accounts/me.controller.ts`:

```ts
import { Body, Controller, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';

import { RateLimiter } from '../../core/rate-limit/rate-limiter';
import { ClaimService } from './claim.service';
import { CurrentAppUser } from './current-app-user.decorator';
import { ClaimDto, UsernameDto } from './dto/me.dto';
import { MeService } from './me.service';
import { type AuthenticatedAppUser, UserAuthGuard } from './user-auth.guard';
import { UsernameService } from './username.service';

@Controller('api/app/v1')
@UseGuards(UserAuthGuard)
export class MeController {
  constructor(
    private readonly me: MeService,
    private readonly usernames: UsernameService,
    private readonly claims: ClaimService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get('me')
  async view(@CurrentAppUser() user: AuthenticatedAppUser) {
    return { success: true as const, data: await this.me.view(user.id) };
  }

  @Get('usernames/:name/availability')
  async availability(@CurrentAppUser() user: AuthenticatedAppUser, @Param('name') name: string) {
    await this.limiter.hit(`username:${user.id}`, 60, 60);
    return { success: true as const, data: await this.usernames.check(name, user.id) };
  }

  @Patch('me/username')
  async changeUsername(@CurrentAppUser() user: AuthenticatedAppUser, @Body() dto: UsernameDto) {
    await this.usernames.change(user.id, dto.username);
    return { success: true as const, data: await this.me.view(user.id) };
  }

  @Post('me/claim')
  @HttpCode(200)
  async claim(@CurrentAppUser() user: AuthenticatedAppUser, @Body() dto: ClaimDto) {
    return { success: true as const, data: await this.claims.claim(user, dto) };
  }
}
```

In `accounts.module.ts`: add `MeController` to `controllers`, and `UsernameService`, `ClaimService` to `providers`.

- [ ] **Step 4: Run the tests**

Run: `npx jest src/modules/accounts && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/accounts
git commit -m "feat: /me, username availability and changes, the claim step

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Account deletion — in the app, on the web, and the page

**Files:**
- Create: `src/modules/accounts/account-deletion.service.ts`, `src/modules/accounts/account-deletion.controller.ts`, `src/modules/accounts/deletion-page.content.ts`, `src/modules/accounts/deletion-page.controller.ts`, `src/modules/accounts/dto/deletion.dto.ts`
- Modify: `src/modules/accounts/me.controller.ts` (`DELETE /me`), `src/modules/accounts/accounts.module.ts` (import `LedgerModule`; controllers; providers; export `AccountDeletionService`)
- Test: `src/modules/accounts/account-deletion.service.spec.ts`, `src/modules/accounts/deletion-page.http.spec.ts`

**Interfaces:**
- Consumes: `LedgerService.post(input, tx)` (Task 5), `OtpService` (Task 6), `AuditService`, `RateLimiter`, `IdentityHashService`.
- Produces:
  - `type DeletionActor = { type: 'user'; id: string } | { type: 'admin'; id: string; reason: string }`
  - `AccountDeletionService.deleteAccount(userId, actor): Promise<void>` (404 if gone)
  - `.requestWebDeletion(email, ip?): Promise<{ sentTo: string }>`, `.confirmWebDeletion(email, code): Promise<void>`
  - Routes: `DELETE /api/app/v1/me {confirm:"DELETE"}`, `POST /api/app/v1/account-deletion/start {email}`, `POST /api/app/v1/account-deletion/confirm {email, code}`, `GET /account-deletion`, `GET /account-deletion/app.js`

- [ ] **Step 1: Write the failing tests**

`src/modules/accounts/account-deletion.service.spec.ts`:

```ts
import { HttpException } from '@nestjs/common';

import { AccountDeletionService } from './account-deletion.service';

function build(user: { accountStatus: string; creditBalance: number } | null = { accountStatus: 'active', creditBalance: 40 }) {
  const tx = {
    user: {
      findUnique: jest.fn(async () => user),
      update: jest.fn(async () => undefined),
    },
    userRefreshToken: { updateMany: jest.fn(async () => ({ count: 2 })) },
    userSession: { updateMany: jest.fn(async () => ({ count: 1 })) },
    device: { updateMany: jest.fn(async () => ({ count: 1 })) },
    bonusClaim: { deleteMany: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    user: { findUnique: jest.fn(async () => ({ id: 'u1' })) },
  };
  const ledger = { post: jest.fn(async () => ({ replayed: false })) };
  const otp = { send: jest.fn(async () => ({})), verify: jest.fn(async () => undefined) };
  const audit = { record: jest.fn(async (_e: unknown) => undefined) };
  const limiter = { hit: jest.fn(async () => undefined) };
  const hashes = { hash: jest.fn(() => 'ip-hash') };
  const svc = new AccountDeletionService(prisma as never, ledger as never, otp as never, audit as never, limiter as never, hashes as never);
  return { svc, tx, prisma, ledger, otp, audit };
}

describe('AccountDeletionService.deleteAccount', () => {
  it('forfeits credits through the ledger, ends sessions, unlinks installs and erases personal data', async () => {
    const { svc, tx, ledger, audit } = build();
    await svc.deleteAccount('u1', { type: 'user', id: 'u1' });

    expect(ledger.post).toHaveBeenCalledWith(
      { userId: 'u1', type: 'account_deleted', amount: -40, reference: 'u1' },
      tx,
    );
    expect(tx.userRefreshToken.updateMany).toHaveBeenCalledWith({
      where: { session: { userId: 'u1' }, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(tx.userSession.updateMany).toHaveBeenCalledWith({ where: { userId: 'u1', revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    expect(tx.device.updateMany).toHaveBeenCalledWith({ where: { userId: 'u1' }, data: { userId: null } });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: {
        email: null, googleSub: null, username: null, referralCode: null, phone: null, displayName: null,
        avatarUrl: null, accountStatus: 'deleted', deletedAt: expect.any(Date),
      },
    });
    // The anti-fraud claim records survive deletion.
    expect(tx.bonusClaim.deleteMany).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.deleted', actorType: 'user', entityId: 'u1' }));
  });

  it('skips the forfeit row for an empty balance', async () => {
    const { svc, ledger } = build({ accountStatus: 'active', creditBalance: 0 });
    await svc.deleteAccount('u1', { type: 'user', id: 'u1' });
    expect(ledger.post).not.toHaveBeenCalled();
  });

  it('answers 404 for an account already deleted', async () => {
    const { svc } = build({ accountStatus: 'deleted', creditBalance: 0 });
    const error = (await svc.deleteAccount('u1', { type: 'user', id: 'u1' }).catch((e: unknown) => e)) as HttpException;
    expect(error.getStatus()).toBe(404);
  });
});

describe('AccountDeletionService on the web', () => {
  it('only emails a code when an account exists, and answers the same either way', async () => {
    const { svc, prisma, otp } = build();
    await expect(svc.requestWebDeletion(' Ann@Example.com ', '10.0.0.1')).resolves.toEqual({ sentTo: 'ann@example.com' });
    expect(otp.send).toHaveBeenCalledWith('delete_account', 'ann@example.com', { ip: '10.0.0.1' });

    prisma.user.findUnique.mockResolvedValueOnce(null as never);
    otp.send.mockClear();
    await expect(svc.requestWebDeletion('nobody@example.com')).resolves.toEqual({ sentTo: 'nobody@example.com' });
    expect(otp.send).not.toHaveBeenCalled();
  });

  it('deletes after the emailed code checks out', async () => {
    const { svc, otp, tx } = build();
    await svc.confirmWebDeletion('ann@example.com', '123456');
    expect(otp.verify).toHaveBeenCalledWith('delete_account', 'ann@example.com', '123456');
    expect(tx.user.update).toHaveBeenCalled();
  });
});
```

`src/modules/accounts/deletion-page.http.spec.ts`:

```ts
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { DeletionPageController } from './deletion-page.controller';

describe('account deletion page', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [DeletionPageController] }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the page with a strict content security policy', async () => {
    const res = await fetch(`${base}/account-deletion`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    const html = await res.text();
    expect(html).toContain('id="form-email"');
    expect(html).toContain('<script src="/account-deletion/app.js"');
  });

  it('serves the script that calls the deletion endpoints', async () => {
    const res = await fetch(`${base}/account-deletion/app.js`);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(await res.text()).toContain('/api/app/v1/account-deletion/');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx jest src/modules/accounts/account-deletion.service.spec.ts src/modules/accounts/deletion-page.http.spec.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/modules/accounts/account-deletion.service.ts`:

```ts
import { HttpStatus, Injectable } from '@nestjs/common';

import { AuditService } from '../../core/audit/audit.service';
import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { normalizeEmail } from '../../core/identity/email';
import { IdentityHashService } from '../../core/identity/identity-hash.service';
import { RateLimiter } from '../../core/rate-limit/rate-limiter';
import { AccountStatus, CreditTxType } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { LedgerService } from '../credits/ledger.service';
import { OtpService } from './otp.service';

export type DeletionActor = { type: 'user'; id: string } | { type: 'admin'; id: string; reason: string };

@Injectable()
export class AccountDeletionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly otp: OtpService,
    private readonly audit: AuditService,
    private readonly limiter: RateLimiter,
    private readonly hashes: IdentityHashService,
  ) {}

  /**
   * Erases personal data and forfeits the balance, in one transaction. Ledger
   * and referral rows keep the now-anonymous user id; BonusClaim rows are kept
   * on purpose, so deleting and re-creating earns no second bonus.
   */
  async deleteAccount(userId: string, actor: DeletionActor): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { accountStatus: true, creditBalance: true } });
      if (!user || user.accountStatus === AccountStatus.deleted) {
        throw appError(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'This account no longer exists.');
      }
      if (user.creditBalance > 0) {
        await this.ledger.post({ userId, type: CreditTxType.account_deleted, amount: -user.creditBalance, reference: userId }, tx);
      }
      await tx.userRefreshToken.updateMany({ where: { session: { userId }, revokedAt: null }, data: { revokedAt: now } });
      await tx.userSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
      await tx.device.updateMany({ where: { userId }, data: { userId: null } });
      await tx.user.update({
        where: { id: userId },
        data: {
          email: null, googleSub: null, username: null, referralCode: null, phone: null, displayName: null,
          avatarUrl: null, accountStatus: AccountStatus.deleted, deletedAt: now,
        },
      });
    });
    await this.audit.record({
      actorId: actor.id,
      actorType: actor.type,
      action: 'user.deleted',
      entityType: 'User',
      entityId: userId,
      after: actor.type === 'admin' ? { reason: actor.reason } : { by: 'self' },
    });
  }

  /** Google Play's web deletion route. Same answer whether or not the account exists. */
  async requestWebDeletion(rawEmail: string, ip?: string): Promise<{ sentTo: string }> {
    const email = normalizeEmail(rawEmail);
    if (ip) await this.limiter.hit(`deletion:ip:${this.hashes.hash('ip', ip)}`, 20, 3_600);
    const user = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (user) await this.otp.send('delete_account', email, { ip });
    return { sentTo: email };
  }

  async confirmWebDeletion(rawEmail: string, code: string): Promise<void> {
    const email = normalizeEmail(rawEmail);
    await this.otp.verify('delete_account', email, code);
    const user = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (!user) throw appError(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.OTP_EXPIRED, 'This code has expired. Request a new one.');
    await this.deleteAccount(user.id, { type: 'user', id: user.id });
  }
}
```

`src/modules/accounts/dto/deletion.dto.ts`:

```ts
import { Transform, TransformFnParams } from 'class-transformer';
import { IsEmail, Matches, MaxLength } from 'class-validator';

const lower = ({ value }: TransformFnParams): unknown => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export class DeletionStartDto {
  @Transform(lower)
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class DeletionConfirmDto extends DeletionStartDto {
  @Matches(/^\d{6}$/, { message: 'code must be the 6 digits from the email' })
  code!: string;
}
```

`src/modules/accounts/account-deletion.controller.ts`:

```ts
import { Body, Controller, HttpCode, Ip, Post } from '@nestjs/common';

import { AccountDeletionService } from './account-deletion.service';
import { DeletionConfirmDto, DeletionStartDto } from './dto/deletion.dto';

/** Deletion without the app (Google Play requirement), used by the page at /account-deletion. */
@Controller('api/app/v1/account-deletion')
export class AccountDeletionController {
  constructor(private readonly deletion: AccountDeletionService) {}

  @Post('start')
  @HttpCode(200)
  async start(@Body() dto: DeletionStartDto, @Ip() ip: string) {
    return { success: true as const, data: await this.deletion.requestWebDeletion(dto.email, ip) };
  }

  @Post('confirm')
  @HttpCode(200)
  async confirm(@Body() dto: DeletionConfirmDto) {
    await this.deletion.confirmWebDeletion(dto.email, dto.code);
    return { success: true as const, data: { deleted: true } };
  }
}
```

`src/modules/accounts/deletion-page.content.ts`:

```ts
export const DELETION_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Delete your SlimShot account</title>
<style>
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: #09090b; color: #fafafa; }
  main { max-width: 420px; margin: 0 auto; padding: 48px 16px; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p { color: #a1a1aa; }
  label { display: block; margin: 16px 0 6px; font-size: 14px; }
  input { width: 100%; box-sizing: border-box; height: 44px; padding: 0 12px; border-radius: 8px; border: 1px solid #3f3f46; background: #18181b; color: #fafafa; font-size: 16px; }
  button { margin-top: 16px; width: 100%; height: 44px; border: 0; border-radius: 8px; background: #ef4444; color: #fff; font-size: 16px; cursor: pointer; }
  #error { color: #f87171; min-height: 24px; }
</style>
</head>
<body>
<main>
  <h1>Delete your SlimShot account</h1>
  <p>This removes your email, username and sign-in, and forfeits your credits. It cannot be undone.</p>
  <section id="step-email">
    <form id="form-email">
      <label for="email">Your account email</label>
      <input id="email" type="email" autocomplete="email" required>
      <button type="submit">Email me a code</button>
    </form>
  </section>
  <section id="step-code" hidden>
    <p>If an account uses that email, we sent it a 6-digit code.</p>
    <form id="form-code">
      <label for="code">Code</label>
      <input id="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required>
      <button type="submit">Delete my account</button>
    </form>
  </section>
  <section id="step-done" hidden>
    <p>Your account has been deleted.</p>
  </section>
  <p id="error" role="alert"></p>
</main>
<script src="/account-deletion/app.js"></script>
</body>
</html>
`;

export const DELETION_PAGE_JS = `'use strict';
const byId = (id) => document.getElementById(id);
async function post(path, body) {
  const res = await fetch('/api/app/v1/account-deletion/' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!json || !json.success) throw new Error((json && json.error && json.error.message) || 'Something went wrong. Try again.');
  return json.data;
}
function show(step) {
  for (const id of ['step-email', 'step-code', 'step-done']) byId(id).hidden = id !== step;
}
function fail(message) { byId('error').textContent = message; }
byId('form-email').addEventListener('submit', async (event) => {
  event.preventDefault();
  fail('');
  try { await post('start', { email: byId('email').value }); show('step-code'); } catch (err) { fail(err.message); }
});
byId('form-code').addEventListener('submit', async (event) => {
  event.preventDefault();
  fail('');
  try { await post('confirm', { email: byId('email').value, code: byId('code').value }); show('step-done'); } catch (err) { fail(err.message); }
});
`;
```

`src/modules/accounts/deletion-page.controller.ts`:

```ts
import { Controller, Get, Header } from '@nestjs/common';

import { DELETION_PAGE_HTML, DELETION_PAGE_JS } from './deletion-page.content';

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

/** The web deletion page whose URL goes in the Play Console. */
@Controller('account-deletion')
export class DeletionPageController {
  @Get()
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('content-security-policy', CSP)
  page(): string {
    return DELETION_PAGE_HTML;
  }

  @Get('app.js')
  @Header('content-type', 'text/javascript; charset=utf-8')
  script(): string {
    return DELETION_PAGE_JS;
  }
}
```

In `src/modules/accounts/me.controller.ts`: import `Delete` from `@nestjs/common`, `DeleteMeDto` from `./dto/me.dto`, `AccountDeletionService` from `./account-deletion.service`; add `private readonly deletion: AccountDeletionService,` to the constructor; add:

```ts
  @Delete('me')
  async remove(@CurrentAppUser() user: AuthenticatedAppUser, @Body() _dto: DeleteMeDto) {
    await this.deletion.deleteAccount(user.id, { type: 'user', id: user.id });
    return { success: true as const, data: { deleted: true } };
  }
```

In `accounts.module.ts`: add `LedgerModule` (from `../credits/ledger.module`) to `imports`; add `AccountDeletionController` and `DeletionPageController` to `controllers`; add `AccountDeletionService` to `providers` and `exports`.

- [ ] **Step 4: Run the tests**

Run: `npx jest src/modules/accounts && npm run lint && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/accounts
git commit -m "feat: account deletion in the app and on the web, with the deletion page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: App contract, part 1 — accounts

**Files:**
- Create: `docs/app-credits-api.md`

- [ ] **Step 1: Write the document**

Audience: the mobile developer. Keep the style of `docs/app-api/auto-caption.md`. Content, in order — every value below is exact:

1. **Basics:** base URL `/api/app/v1`; the envelope; branch on `error.code`; `traceId` in bug reports; `details` carries extra fields where noted.
2. **Who does what:** the app/server table from spec §3 (copy it).
3. **Install token:** `POST /devices` once per install (unchanged), keep the token; every sign-in sends it as `deviceToken`.
4. **Google sign-in:** Google Cloud setup (Android OAuth client with package name + SHA-1; Web OAuth client; the app passes the **Web client ID** as the SDK's server client ID); the app uses the account picker (Credential Manager / `google_sign_in`) to get an **ID token**; `POST /auth/google {idToken, deviceToken}`.
5. **Email code:** `POST /auth/email/start {email, deviceToken}` → `200 {sentTo, resendAfterSeconds, expiresInSeconds}` (same answer whether or not an account exists); `POST /auth/email/verify {email, code, deviceToken}`. Codes: 6 digits, 10 minutes, 5 tries, resend after 60 s.
6. **Sign-in response** (both methods): `{accessToken, refreshToken, expiresIn, isNewAccount, needsClaim, user}` where `user` is the `/me` object. `needsClaim: true` → show the username screen.
7. **Tokens:** send `Authorization: Bearer <accessToken>`; on `401 UNAUTHENTICATED` call `POST /auth/refresh {refreshToken}` **once** and retry; refresh tokens rotate on every use and an old one ends the session, so the app must never run two refreshes at the same time (single-flight); on `401 SIGN_IN_REQUIRED` or a failed refresh, show sign-in. `POST /auth/logout {refreshToken}` → `{loggedOut: true}`. Store both tokens in secure storage.
8. **`GET /me`:** every field of `MeView` with meaning (`ads.remainingToday` resets at 00:00 UTC).
9. **Username:** rules (3–20, a–z 0–9 _, case-insensitive, reserved names); `GET /usernames/{name}/availability` → `{username, available, reason?}` with `INVALID|RESERVED|TAKEN` (60 checks per minute; debounce typing); `PATCH /me/username {username}` → `/me`.
10. **Claim:** `POST /me/claim {username, referralCode?}` → `{user, bonus, referral}`; in this milestone `bonus` and `referral` are `null` (filled in Milestone 2).
11. **Deleting the account:** `DELETE /me` with body `{"confirm":"DELETE"}` (Dart: `http.Request('DELETE', …)` with a JSON body) → `{deleted: true}`; then clear stored tokens. Web route for people without the app: `https://<server>/account-deletion` (its URL goes in the Play Console).
12. **Error table:** `401 SIGN_IN_REQUIRED`, `401 UNAUTHENTICATED`, `422 DEVICE_NOT_REGISTERED`, `401 GOOGLE_TOKEN_INVALID`, `422 GOOGLE_EMAIL_UNVERIFIED`, `503 SIGN_IN_METHOD_UNAVAILABLE`, `422 EMAIL_DOMAIN_NOT_ALLOWED`, `409 ACCOUNT_LINK_CONFLICT`, `422 OTP_INVALID {attemptsLeft}`, `422 OTP_EXPIRED`, `429 OTP_ATTEMPTS_EXCEEDED`, `429 OTP_RESEND_TOO_SOON {retryAfterSeconds}`, `429 RATE_LIMITED {retryAfterSeconds}`, `422 USERNAME_INVALID`, `409 USERNAME_TAKEN`, `409 ALREADY_CLAIMED`, `403 ACCOUNT_SUSPENDED`, `422 VALIDATION_FAILED` — each with what the app should do.

- [ ] **Step 2: Check it against the code**

```bash
for c in SIGN_IN_REQUIRED UNAUTHENTICATED DEVICE_NOT_REGISTERED GOOGLE_TOKEN_INVALID GOOGLE_EMAIL_UNVERIFIED SIGN_IN_METHOD_UNAVAILABLE EMAIL_DOMAIN_NOT_ALLOWED ACCOUNT_LINK_CONFLICT OTP_INVALID OTP_EXPIRED OTP_ATTEMPTS_EXCEEDED OTP_RESEND_TOO_SOON RATE_LIMITED USERNAME_INVALID USERNAME_TAKEN ALREADY_CLAIMED ACCOUNT_SUSPENDED; do grep -q "$c = '$c'" src/core/errors/error-codes.ts && grep -q "$c" docs/app-credits-api.md && echo "ok $c" || echo "MISSING $c"; done
```

Expected: every line `ok`.

- [ ] **Step 3: Commit, and run Milestone 1 end to end**

```bash
npx jest && npm run lint && npm run typecheck && npm run build
git add docs/app-credits-api.md
git commit -m "docs: app contract for accounts and sign-in

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the whole suite passes. **Milestone 1 is complete** (owner can test sign-in, `/me`, username, claim and deletion after `migrate deploy`).

---

# Milestone 2 — Credits and paid captions

Builds on Milestone 1 as committed. `CreditsModule` (Task 13) imports `LedgerModule`,
`CreditSettingsModule` and `AccountsModule` (for `UserAuthGuard`) and re-exports `LedgerModule`
and `PricingService`. `ClaimService` (Task 16) stays in `accounts/` because `CreditsModule`
depends on `AccountsModule`, not the other way round. Full code for every step is in the
commits; tests are listed in full below because they define the behaviour.

### Task 13: Pricing, quote and history

**Files:**
- Create: `src/modules/credits/pricing.ts`, `pricing.service.ts`, `credits.service.ts`, `credits.controller.ts`, `dto/credits.dto.ts`, `credits.module.ts`
- Modify: `src/app.module.ts` (import `CreditsModule` after `AccountsModule`)
- Test: `src/modules/credits/pricing.spec.ts`, `pricing.service.spec.ts`, `credits.service.spec.ts`

**Interfaces:**
- Produces:
  - `interface PriceTier { upToSeconds: number | null; credits: number }`
  - `interface PricedRule { id: string; version: number; mode: PricingMode; perJobCredits: number | null; tiers: PriceTier[] | null }`
  - `priceFor(rule, durationSeconds): number` — first tier with `durationSeconds <= upToSeconds` (inclusive) or the open-ended last tier; `per_job` returns `perJobCredits ?? 0`
  - `tierProblems(tiers): string[]` — messages containing: "At least one tier", "last tier must be open-ended", "only the last tier can be open-ended", "greater than the tier before", "credits must be a whole number" (used by Task 22)
  - `PricingService.activeRule(feature)`: `pricingRule.findFirst({ where: { feature, isActive: true } })` mapped to `PricedRule`; `.price(feature, seconds): { credits, rule }` → `503 CAPTIONS_UNAVAILABLE` "Auto caption is not available right now. Try again later." without a rule
  - `CreditsService.quote(userId, feature, seconds)` → `{ credits, balance, enough: balance >= credits, pricingVersion }`; `.history(userId, cursor?, limit = 20)` → `findMany({ where: { userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: { id, type, amount, balanceAfter, createdAt } })` → `{ items: first limit, nextCursor: rows.length > limit ? last item id : null }`
  - DTOs: `QuoteDto { @IsEnum(CreditFeature) feature; @IsNumber({maxDecimalPlaces: 3}) @Min(0.001) @Max(14400) durationSeconds }`; `HistoryQueryDto { @IsOptional @IsString @MaxLength(40) cursor?; @IsOptional @Type(() => Number) @IsInt @Min(1) @Max(100) limit? }`
  - Routes (`UserAuthGuard`): `POST /api/app/v1/credits/quote` (`@HttpCode(200)`), `GET /api/app/v1/credits/history`
  - `CreditsModule`: imports `[LedgerModule, CreditSettingsModule, AccountsModule]`, providers `[PricingService, CreditsService]`, exports `[PricingService, CreditsService, LedgerModule]`

- [ ] **Step 1: Failing tests.** `pricing.spec.ts`: with tiers `[60→2, 180→5, null→9]`, `priceFor` gives 0.5→2, 60→2, 60.001→5, 180→5, 180.5→9, 3600→9; per-job rule with `perJobCredits: 4` → 4; `tierProblems` of the valid list → `[]`, and each of the five invalid lists reports its message. `pricing.service.spec.ts`: active rule `{ id: 'r1', version: 2, mode: 'per_job', perJobCredits: 3 }` → `{ credits: 3, rule: { id: 'r1', version: 2 } }` and `findFirst` called with `{ where: { feature: 'auto_captions', isActive: true } }`; no rule → 503 `CAPTIONS_UNAVAILABLE`. `credits.service.spec.ts`: quote with balance 94 → enough true, 5 → false (credits 6, pricingVersion 3); history with three rows and limit 2 → two items, `nextCursor: 't2'`, exact `findMany` arguments above; with cursor `t2` → `cursor: { id: 't2' }, skip: 1`; one row → `nextCursor: null`.
- [ ] **Step 2:** `npx jest src/modules/credits` → FAIL (modules not found).
- [ ] **Step 3:** implement the files above; wire `CreditsModule` into `AppModule`.
- [ ] **Step 4:** `npx jest src/modules/credits && npm run lint && npm run typecheck` → PASS. Commit `feat: pricing rules, credit quote and history`.

---

### Task 14: WAV duration from the header

**Files:** Create `src/modules/captions/wav.ts`, `test/fakes/wav.ts`; Test `src/modules/captions/wav.spec.ts`.

**Interfaces:**
- `class InvalidWavError extends Error`; `wavDurationSeconds(audio: Buffer): number` = data bytes ÷ byte rate. Walk chunks after `RIFF….WAVE`; `fmt ` must be PCM (1) or extensible (0xFFFE) with a non-zero byte rate and come before `data`; `data` bytes = `min(declared size, bytes present)` (streaming placeholder sizes and cut-short uploads); odd chunk sizes skip one pad byte. Errors: "The upload is not a WAV file.", "Only uncompressed PCM WAV is supported.", "The WAV has no format chunk before its audio.", "The WAV contains no audio.", "The WAV format header is incomplete.", "The WAV header has a zero byte rate."
- Test helper `test/fakes/wav.ts`: `riffChunk(id, body, declaredSize = body.length)` (pads odd bodies) and `makeWav({ seconds, sampleRate = 16000, channels = 1, bits = 16, format = 1, extraChunks, dataSizeOverride, omitFmt })` building a silent WAV byte by byte.

- [ ] **Step 1: Failing tests:** 2.5 s mono 16 kHz → 2.5; 1 s stereo 44.1 kHz → 1; `LIST` (5 bytes, odd) and `JUNK` chunks before `data` → 3; `dataSizeOverride: 0xffffffff` → 2; a 4 s file with its last 32 000 bytes cut → 3; refuses not-RIFF, format 85, data without fmt, zero seconds (`InvalidWavError`).
- [ ] **Step 2:** FAIL (module not found). **Step 3:** implement. **Step 4:** PASS + lint. Commit `feat: measure WAV duration from the header`.

---

### Task 15: Paid captions — sign-in, WAV, charge, refund

**Files:**
- Create `src/modules/captions/caption-refunds.ts` (+ spec)
- Replace `captions.service.ts`, `caption.worker.ts`, `captions.controller.ts` and their specs (`captions.service.spec.ts`, `caption.worker.spec.ts`, `captions.http.spec.ts`)
- Modify `captions.constants.ts` (`CaptionJobData { userId, filePath, mimeType, language, credits }`; `captionJobId(userId, key)`), `captions.module.ts` (imports `AccountsModule`, `CreditsModule`, `ProvidersModule`; providers add `CaptionRefunds`; drop `DevicesModule`)
- Delete `src/modules/devices/device-auth.guard.ts`, `device-auth.guard.spec.ts`, `current-device.decorator.ts`; `DevicesModule` keeps only `DevicesController` + `DevicesService`

**Interfaces:**
- `CaptionRefunds.refund(userId: string | undefined, jobId, credits: number | undefined, reason): Promise<void>` — no-op without userId or with credits ≤ 0 (free jobs, jobs queued before credits existed); posts `{ userId, type: feature_refund, amount: credits, reference: jobId, metadata: { reason } }`; on any ledger error logs (`Logger.error`) and audits `credits.refund.failed` (actorType `system`, entityType `User`, after `{ jobId, credits, reason }`); never throws.
- `WAV_MIME_TYPES = {audio/wav, audio/x-wav, audio/wave, audio/vnd.wave}`
- `CaptionsService(queue, providers: ProviderCredentialsService, pricing, ledger, refunds, cfg)`. `start(user: AuthenticatedAppUser, audio, language, key): StartedCaptionView` (= `CaptionJobView & { charged?: { credits, balance } }`), in order:
  1. suspended → `403 ACCOUNT_SUSPENDED`; 2. no active provider → `503 CAPTIONS_UNAVAILABLE`;
  3. `jobId = captionJobId(user.id, key)`; existing job → its view (no charge);
  4. mimetype not in `WAV_MIME_TYPES` → `415 UNSUPPORTED_MEDIA` "Upload WAV audio (audio/wav); got <type>.";
  5. `wavDurationSeconds` (`InvalidWavError` → `422 INVALID_AUDIO` with its message);
  6. `pricing.price(auto_captions, duration)`;
  7. credits > 0 → `ledger.post({ userId, type: feature_charge, amount: -credits, reference: jobId, requireActive: true, metadata: { feature: 'auto_captions', durationSeconds, pricingRuleId, pricingVersion } })` → `charged = { credits, balance: transaction.balanceAfter }`;
  8. in one try: mkdir (0700), write `<jobId>.audio` (0600), `queue.add('transcribe', { userId, filePath, mimeType, language ?? null, credits }, { jobId, attempts: 2, backoff fixed 2000, removeOnComplete/removeOnFail { age: TTL } })`; on failure remove the file, `refunds.refund(user.id, jobId, credits, 'queue_failed')`, rethrow;
  9. `202 { jobId, status: 'queued', pollAfterMs, charged? }`.
  `status(user, jobId)` as before but scoped to `job.data.userId`.
- `CaptionWorker(credentials, refunds, cfg)`: as before plus `failedForGood` (no provider, provider refusal, last attempt) → `refunds.refund(userId, job.id, credits, 'job_failed')` in `finally`; the `rm` in `finally` is wrapped (`.catch` → `Logger.warn`) so a cleanup error never turns a paid result into a failure.
- `CaptionsController`: `@UseGuards(UserAuthGuard)`, `@CurrentAppUser()`; keeps the Idempotency-Key and missing-audio 422s; the mimetype check moves to the service.

- [ ] **Step 1: Failing tests.**
  - `caption-refunds.spec.ts`: posts the refund keyed by the job; no-op for credits 0 and for missing userId/credits; a ledger 404 is logged and audited (`credits.refund.failed`) and the call resolves.
  - `captions.service.spec.ts` (WAV bodies from `makeWav`): suspended → `ACCOUNT_SUSPENDED`, no ledger call; no provider → 503; `application/octet-stream` → 415 naming the type, no ledger call; unreadable WAV → `INVALID_AUDIO`; a 3 s WAV → `pricing.price('auto_captions', ≈3)`, the exact ledger charge above, file written, exact `queue.add` arguments, view `{ jobId, status: 'queued', pollAfterMs: 1500, charged: { credits: 6, balance: 88 } }`; ledger 402 → no queue, no tmp dir; 0-credit job → no ledger call, no `charged`; resend with the same key → one charge, one job; `queue.add` failure → no file, `refund(u1, jobId, 6, 'queue_failed')`; POSIX file mode 0600; status: waiting/delayed→queued, active→processing, completed→result, another user → 404, older than TTL → 404.
  - `caption.worker.spec.ts`: success → result, file gone, no refund; provider 400 → `UnrecoverableError`, file gone, `refund('u1','cap_x',6,'job_failed')`; 503 on attempt 1 → file kept, no refund; network error on the last attempt → file gone, refund; no provider → `UnrecoverableError`, refund; the file path is a directory (rm fails) → the result is still returned, a warning logged, no refund; the key never appears in warnings; concurrency applied on bootstrap.
  - `captions.http.spec.ts`: `UserAuthGuard` overridden with a fake that accepts `Bearer a.b.c` and otherwise throws `401 SIGN_IN_REQUIRED`; `POST /devices` still works unauthenticated; 202 passes the app user, `audio/wav` part, lowercased language and key; no bearer and a device-token bearer → 401 `SIGN_IN_REQUIRED` without calling the service; bad keys → 422; no audio → 422; oversize → 413 `PAYLOAD_TOO_LARGE`; a service 402 passes through with `details { required, balance }`; polling passes the user.
- [ ] **Step 2:** `npx jest src/modules/captions` → FAIL.
- [ ] **Step 3:** implement, delete the device guard files, update the modules.
- [ ] **Step 4:** `npx jest && npm run lint && npm run typecheck && npm run build` → PASS. Commit `feat: paid captions: sign-in, WAV duration, charge, automatic refund`.

---

### Task 16: Signup bonus and referrals in the claim

**Files:** Replace `src/modules/accounts/claim.service.ts` and its spec.

**Interfaces:**
- `ClaimService(prisma, usernames, me, settings: CreditSettingsService, hashes: IdentityHashService, ledger: LedgerService)`
- `ClaimResult { user: MeView; bonus: { granted: boolean; credits: number; reason?: 'BONUS_ALREADY_CLAIMED' | 'IP_LIMIT_REACHED' }; referral: { outcome: ReferralOutcome; credits: number } | null }`
- Flow: suspended → 403; already claimed → 409; username via `assertAvailable`; referral code (if any) → `findInviter` (normalised; unknown, own or non-active inviter → `422 REFERRAL_CODE_INVALID` "That referral code is not valid.") **before writing anything**; keys `hash('bonus-email', canonicalEmail(email))` (null without email) and `hash('bonus-install', deviceId)`; eligibility: `signupIpLimited` → `IP_LIMIT_REACHED`; any matching `BonusClaim` (`findFirst` with `OR`) → `BONUS_ALREADY_CLAIMED`; then one transaction: `updateMany({ where: { id, claimedAt: null }, data: { username, claimedAt } })` (count 0 → 409), if eligible create the `BonusClaim` rows (email, install) and post `signup_bonus` (reference userId) when the setting > 0; referral: when the invitee is eligible lock the inviter row (`tx.$queryRaw … FOR UPDATE`), count rewarded referrals in the last `referralCapDays` → `inviter_capped` at the cap else `rewarded`; not eligible → `invitee_ineligible`; create the `Referral`; invitee gets `referral_invitee` unless ineligible; inviter gets `referral_inviter` only when `rewarded` (both reference the referral id). A unique violation from the transaction: if the username now belongs to someone else → `409 USERNAME_TAKEN`; otherwise re-run the transaction as not eligible (`BONUS_ALREADY_CLAIMED`).

- [ ] **Step 1: Failing tests** (in-memory fake with snapshot rollback; ledger mocked): new email + new install → bonus `{ granted: true, credits: 100 }`, two `BonusClaim` rows, `signup_bonus` post; seeded email claim (delete-and-recreate) → `BONUS_ALREADY_CLAIMED`, no post, username set; seeded install claim (second account on one phone) → `BONUS_ALREADY_CLAIMED`; `a.nn+promo@gmail.com` blocked by a claim for `ann@gmail.com`; IP-limited → `IP_LIMIT_REACHED`, no claim rows; referral with `' invite22 '` → `rewarded`, both posts referencing `ref-1`; inviter at cap 1 → `inviter_capped`, invitee 20, no inviter post; ineligible invitee → `invitee_ineligible`, no posts; codes `NOPE0000`, own `SELFCODE`, suspended inviter's `SUSPEND3` → 422 with `claimedAt` still null; a forced unique violation on the first `BonusClaim` insert → falls back to `BONUS_ALREADY_CLAIMED`, username and `claimedAt` set; second claim → 409, suspended → 403.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** `npx jest src/modules/accounts && npm run lint && npm run typecheck`. Commit `feat: signup bonus and referrals in the claim step`.

---

### Task 17: Daily balance check

**Files:** Create `src/modules/credits/reconciliation.service.ts` (+ spec); provide and export it from `CreditsModule`.

**Interfaces:** `BalanceMismatch { userId, cached, ledger }`; `check()` runs one SQL query (`User` LEFT JOIN `CreditTransaction`, `GROUP BY` user, `HAVING creditBalance <> COALESCE(SUM(amount), 0)`, `::int`); `run()` logs (`Logger.error`) and audits `credits.reconcile.mismatch` per mismatch (actorType `system`, after `{ cached, ledger }`), swallows errors with a warning and returns `[]`; `onModuleInit` schedules a first run after 5 minutes and then every 24 h with `unref`'d timers; `onModuleDestroy` clears them.

- [ ] **Steps:** failing spec (mapping, audit per mismatch, survives a DB error, schedules without hanging) → FAIL → implement → PASS + lint + typecheck. Commit `feat: daily check that balances equal their ledger`.

---

### Task 18: App contract, part 2 — credits and paid captions

**Files:** Modify `docs/app-credits-api.md`; replace `docs/app-api/auto-caption.md` with a pointer.

- [ ] **Step 1:** Status: Milestones 1–2 live. Add: **Credits** (`/me.creditBalance`; `GET /credits/history?cursor=&limit=` 1–100, default 20 → `{ items: [{ id, type, amount, balanceAfter, createdAt }], nextCursor }`, every `type` explained); **Quote** (`POST /credits/quote { feature: "auto_captions", durationSeconds }` → `{ credits, balance, enough, pricingVersion }`, show "This will use N credits · You have M", the server re-measures the same WAV); **Auto captions, now paid** (sign-in required; WAV only via `ffmpeg -i input.mp4 -vn -ac 1 -ar 16000 -c:a pcm_s16le audio.wav`, ≈1.9 MB/min, 50 MB ≈ 26 min; part type `audio/wav`; Idempotency-Key rule; `202 { jobId, status, pollAfterMs, charged? }`; failed jobs refunded automatically; polling and result format carried over from the old guide; Dart snippet with the access token and `MediaType('audio', 'wav')`; curl); **Claim filled in** (`bonus` reasons, `referral` outcomes, how referral codes work); error table additions: `402 INSUFFICIENT_CREDITS {required, balance}`, `415 UNSUPPORTED_MEDIA`, `422 INVALID_AUDIO`, `413 PAYLOAD_TOO_LARGE`, `503 CAPTIONS_UNAVAILABLE`, `422 REFERRAL_CODE_INVALID`, `404 NOT_FOUND`. `auto-caption.md` becomes a short pointer to the new contract.
- [ ] **Step 2:** check each of `INSUFFICIENT_CREDITS UNSUPPORTED_MEDIA INVALID_AUDIO PAYLOAD_TOO_LARGE CAPTIONS_UNAVAILABLE REFERRAL_CODE_INVALID BONUS_ALREADY_CLAIMED IP_LIMIT_REACHED inviter_capped` appears; `npx jest && npm run lint && npm run typecheck && npm run build`; commit `docs: app contract for credits and paid captions`. **Milestone 2 is complete.**

---

# Milestone 3 — Rewarded ads (AdMob server-side verification)

Same format as Milestone 2: exact interfaces, flows and test cases; the executor writes the code
test-first. New module `src/modules/rewards/`.

### Task 19: AdMob signature verification

**Files:** Create `src/modules/rewards/admob-verifier.ts` (+ spec).

**Interfaces:**
- `class SsvSignatureError extends Error`
- `interface SsvCallback { adUnit; customData; userId; transactionId; rewardAmount; timestamp; keyId }` (all strings; missing → `''`)
- `AdmobVerifier(@Inject(admobConfig.KEY) cfg).verify(rawQuery: string): Promise<SsvCallback>`:
  - the signed content is the raw query up to (not including) `&signature=`; the tail holds `signature` (base64url, DER) and `key_id`; missing either → `SsvSignatureError`;
  - `crypto.verify('sha256', content, { key, dsaEncoding: 'der' }, signature)`; false → `SsvSignatureError('The callback signature does not match.')`;
  - fields come from `URLSearchParams(content)` (so `custom_data` is percent-decoded);
  - keys: fetched from `cfg.verifierKeysUrl` (JSON `{ keys: [{ keyId, pem, base64 }] }`, `createPublicKey(pem)`), cached 24 h; an unknown `key_id` triggers one refetch (at most once a minute), then `SsvSignatureError('Unknown AdMob key …')`; a failed key fetch throws a plain `Error` (so the callback answers 500 and AdMob retries).

- [ ] **Step 1: Failing tests** (EC P-256 key pair generated in the test; `fetch` spied to serve `{ keys: [{ keyId: 123, pem }] }`): a signed callback parses every field and decodes `custom_data` `n%2Babc` → `n+abc`; a changed `reward_amount` → `SsvSignatureError`; no signature → `SsvSignatureError`; an unknown key id → fetch called a second time, then `SsvSignatureError`; two verifies within 24 h fetch once, a third after 24 h fetches again (`Date.now` mocked).
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS + lint + typecheck. Commit `feat: verify AdMob server-side verification callbacks`.

### Task 20: Ad sessions, the callback and the poll

**Files:** Create `src/modules/rewards/ad-sessions.service.ts`, `rewards.controller.ts`, `rewards.module.ts` (+ `ad-sessions.service.spec.ts`, `rewards.http.spec.ts`); import `RewardsModule` in `AppModule`.

**Interfaces:**
- `AdSessionsService(redis, prisma, ledger, settings, verifier, admobConfig)`:
  - `start(user)` → suspended 403; `remaining = adDailyCap − adsUsedToday`; 0 → `409 AD_DAILY_CAP_REACHED { resetsAt }` (next UTC midnight); else a random nonce (18 bytes base64url) stored in Redis `ad:session:<nonce>` as `{ userId, status: 'pending' }` for 1 h → `{ nonce, ssvUserId: user.id, rewardCredits, adsRemainingToday: remaining }`.
  - `status(user, nonce)` → missing or another user's → `404 NOT_FOUND`; else `{ status, credits?, balance }`.
  - `handleCallback(rawQuery)`: `SsvSignatureError` → `400 BadRequestException`; ad unit not in `cfg.adUnitIds` (when the list is set) → log and return; no session for `custom_data` (including the AdMob console's test callback) → log and return; session user ≠ `user_id` → session `rejected`; else one transaction: `SELECT … FOR UPDATE` on the user row; an existing `rewarded_ad:<transaction_id>` row → `granted` with its amount (replay); today's rewarded ads ≥ cap → `capped`; else `ledger.post({ type: rewarded_ad, amount: adRewardCredits, reference: transaction_id, requireActive: true, metadata: { adUnit, nonce } }, tx)` (skipped when the reward is 0) → `granted`; a ledger 403/404 (suspended or deleted meanwhile) → `rejected`; any other error propagates (500, AdMob retries). The session in Redis is updated with the outcome.
- `RewardsController` at `api/app/v1/rewards`: `POST ads/session` (200, `UserAuthGuard`), `GET ads/session/:nonce` (`UserAuthGuard`), `GET admob/ssv` (public) passing `req.originalUrl` after `?` untouched → `{ received: true }`.
- `RewardsModule`: imports `AccountsModule`, `CreditsModule`, `CreditSettingsModule`; providers `AdmobVerifier`, `AdSessionsService`.

- [ ] **Step 1: Failing tests.** `ad-sessions.service.spec.ts` (real `LedgerService` on `FakeCreditDb`, `FakeRedis`, verifier mocked): start returns `{ nonce, ssvUserId: 'u1', rewardCredits: 5, adsRemainingToday: 10 }` and stores a pending session; at the cap → 409 with `resetsAt`; suspended → 403; a verified callback grants 5 (balance 5) and the poll answers `{ status: 'granted', credits: 5, balance: 5 }`; the same `transaction_id` again grants nothing more; at the cap → `capped`, no grant; a foreign ad unit → nothing granted, session still `pending`; the console test callback (no `custom_data`, no `user_id`) → resolves, nothing granted; `user_id` ≠ session user → `rejected`; a bad signature → 400; a suspended user at callback time → `rejected`; polling another user's nonce → 404. `rewards.http.spec.ts`: the callback route needs no sign-in and passes the raw query string exactly (`custom_data=a%2Bb` kept encoded); a `BadRequestException` from the service → 400; session start requires sign-in.
- [ ] **Step 2:** FAIL. **Step 3:** implement and wire. **Step 4:** `npx jest && npm run lint && npm run typecheck && npm run build`. Commit `feat: rewarded ads with AdMob server-side verification`.

### Task 21: App contract, part 3 — rewarded ads

- [ ] Add a **Rewarded ads** section to `docs/app-credits-api.md`: the flow (start a session → load the rewarded ad with `ServerSideVerificationOptions` `userId = ssvUserId`, `customData = nonce` → show it → after it closes poll `GET /rewards/ads/session/{nonce}` every ~1 s for up to ~30 s); responses; `409 AD_DAILY_CAP_REACHED { resetsAt }`; the AdMob console setup (set each rewarded ad unit's SSV callback URL to `https://<server>/api/app/v1/rewards/admob/ssv`; the server's `ADMOB_AD_UNIT_IDS` must list those units); never grant credits in the app. Add `AD_DAILY_CAP_REACHED` to the error table; status line: ads live. Check, run everything, commit `docs: app contract for rewarded ads`. **Milestone 3 is complete.**

---
