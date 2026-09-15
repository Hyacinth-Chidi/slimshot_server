# SlimShot Content Platform — Phases 0–3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take `slimshot_server` from an unauthenticated audio-only API to a secured, tested asset platform whose audio support runs through a generic kind registry, DB-backed configuration, and a verified ingest pipeline.

**Architecture:** A `core/` layer (crypto, settings, storage adapters, queue, cache, audit) with no feature dependencies, and feature modules depending inward only. Asset kinds register descriptors at boot so the generic asset service never branches on `kind`. Uploads go client → storage provider directly; the server issues signed tickets and verifies the result against the provider rather than trusting the client.

**Tech Stack:** NestJS 11, Prisma 7 (driver adapter `@prisma/adapter-pg`), Neon Postgres, Redis (BullMQ + cache), Cloudinary, Jest, argon2, `@nestjs/jwt`.

**Spec:** `docs/superpowers/specs/2026-09-11-slimshot-content-platform-design.md`

## Global Constraints

- Node.js 20+; the dev machine runs Node 25.2.1, npm 11.6.2.
- Prisma 7.8.0 with `prisma.config.ts` already present — it loads `.env` itself and throws if `DATABASE_URL` is unset. `engine = "classic"`, generator `prisma-client`, output `../src/generated/prisma`. Do not switch generators.
- Prisma 7 CLI flag names: `prisma migrate diff --from-empty --to-schema <path>` (NOT `--to-schema-datamodel`), and `prisma migrate resolve --applied <name>`.
- TypeScript `strict: true` is already on. Keep it on.
- Only three values may read from `process.env`: `DATABASE_URL`, `MASTER_ENCRYPTION_KEY`, `PORT`/`NODE_ENV`. Everything else reads from `SystemSetting` or `StorageProvider`. A `process.env` read anywhere else is a review rejection.
- `AssetFile` and every storage pointer stores provider + key + metadata. Never file bytes, never base64.
- All money-path metadata (`byteSize`, `durationMs`, `format`, `checksum`) comes from `StorageProviderAdapter.verifyUpload()`, never from a client-supplied DTO field.
- Response envelopes: success `{ success: true, data, meta? }`; error `{ success: false, error: { code, message, details?, traceId } }`.
- Commit after every task. Never use `--no-verify`.

---

## File Structure

**Phase 0**
- Create: `.eslintrc.cjs`, `.prettierrc`, `jest.config.ts`, `test/setup-env.ts`, `.github/workflows/ci.yml`
- Create: `prisma/migrations/0_init/migration.sql`
- Create: `src/core/errors/{http-exception.filter.ts,error-codes.ts}`
- Delete: `src/modules/audio/dto/upload-audio.dto.ts`, `src/modules/audio/interfaces/uploaded-audio-file.interface.ts`

**Phase 1**
- Create: `src/core/crypto/{crypto.module.ts,envelope-crypto.service.ts}`
- Create: `src/core/settings/{settings.module.ts,settings.service.ts,setting-registry.ts,setting-definitions.ts}`
- Create: `src/core/storage/{storage.module.ts,storage.registry.ts,storage-adapter.interface.ts,adapters/cloudinary.adapter.ts}`
- Create: `src/core/queue/queue.module.ts`, `src/core/cache/cache.service.ts`, `src/core/audit/audit.service.ts`
- Create: `src/core/health/health.controller.ts`

**Phase 2**
- Create: `src/modules/auth/{auth.module.ts,auth.service.ts,auth.controller.ts,token.service.ts,password.service.ts}`
- Create: `src/core/auth/{jwt-auth.guard.ts,permissions.guard.ts,permissions.ts,current-user.decorator.ts}`

**Phase 3**
- Create: `src/modules/assets/{assets.module.ts,asset.service.ts,kind-registry.ts,asset-kind.interface.ts}`
- Create: `src/modules/assets/kinds/audio/{audio-kind.module.ts,audio.descriptor.ts,audio.processor.ts}`
- Create: `src/modules/ingest/{ingest.module.ts,ingest.service.ts}`
- Create: `src/modules/admin/admin-assets.controller.ts`
- Delete: `src/modules/audio/**` (replaced)

---

# Phase 0 — Baseline

## Task 1: Commit the working tree and delete dead code

**Files:**
- Delete: `src/modules/audio/dto/upload-audio.dto.ts`
- Delete: `src/modules/audio/interfaces/uploaded-audio-file.interface.ts`
- Modify: `package.json` (already modified — `music-metadata` removed)

**Interfaces:**
- Consumes: nothing
- Produces: a clean working tree at a known commit

- [ ] **Step 1: Confirm the two files are genuinely unreferenced**

```bash
cd slimshot_server
grep -rn "UploadAudioDto\|UploadedAudioFile" src/ --include=*.ts
```

Expected: only the two definition files themselves appear. If anything else references them, STOP and report — the plan assumed they were dead.

- [ ] **Step 2: Delete them**

```bash
rm src/modules/audio/dto/upload-audio.dto.ts
rm src/modules/audio/interfaces/uploaded-audio-file.interface.ts
```

- [ ] **Step 3: Verify the project still typechecks**

Run: `npx tsc --noEmit -p tsconfig.build.json`
Expected: exit 0, no output.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: drop music-metadata and dead multipart upload types

Both files are leftovers from the server-side multipart upload flow that
was replaced by direct-to-Cloudinary signed uploads. Neither is imported.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Stand up the test harness

There is no test runner in this repo. `@nestjs/testing` is installed but jest is not, so nothing can run. Every later task in this plan is TDD and depends on this task.

**Files:**
- Create: `jest.config.ts`
- Create: `test/setup-env.ts`
- Create: `src/core/errors/error-codes.ts`
- Create: `src/core/errors/error-codes.spec.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing
- Produces: `npm test` runs jest; `ErrorCode` enum available to all later tasks

- [ ] **Step 1: Install the test toolchain**

```bash
npm i -D jest@^30 ts-jest@^29 @types/jest@^30
```

- [ ] **Step 2: Write `jest.config.ts`**

```ts
import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  collectCoverageFrom: ['src/**/*.ts', '!src/generated/**'],
  coveragePathIgnorePatterns: ['/node_modules/', '/src/generated/'],
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
};

export default config;
```

- [ ] **Step 3: Write `test/setup-env.ts`**

This gives unit tests the two bootstrap env vars so services that read them at construction do not throw. Integration tests override `DATABASE_URL` themselves.

```ts
process.env.NODE_ENV = 'test';
process.env.MASTER_ENCRYPTION_KEY =
  process.env.MASTER_ENCRYPTION_KEY ??
  '0'.repeat(64); // 32 bytes hex — test-only, never a real key
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5432/test';
```

- [ ] **Step 4: Replace the placeholder test script in `package.json`**

Replace the line `"test": "echo \"No tests configured yet\""` with:

```json
"test": "jest",
"test:watch": "jest --watch",
"test:cov": "jest --coverage",
"typecheck": "tsc --noEmit -p tsconfig.build.json"
```

- [ ] **Step 5: Write the failing test**

Create `src/core/errors/error-codes.spec.ts`:

```ts
import { ErrorCode } from './error-codes';

describe('ErrorCode', () => {
  it('exposes stable string codes for the documented failure modes', () => {
    expect(ErrorCode.VALIDATION_FAILED).toBe('VALIDATION_FAILED');
    expect(ErrorCode.NOT_FOUND).toBe('NOT_FOUND');
    expect(ErrorCode.CONFLICT).toBe('CONFLICT');
    expect(ErrorCode.UNAUTHENTICATED).toBe('UNAUTHENTICATED');
    expect(ErrorCode.FORBIDDEN).toBe('FORBIDDEN');
    expect(ErrorCode.INTERNAL).toBe('INTERNAL');
  });

  it('has no duplicate values', () => {
    const values = Object.values(ErrorCode);
    expect(new Set(values).size).toBe(values.length);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx jest src/core/errors/error-codes.spec.ts`
Expected: FAIL — `Cannot find module './error-codes'`.

- [ ] **Step 7: Write the minimal implementation**

Create `src/core/errors/error-codes.ts`:

```ts
export enum ErrorCode {
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  UNAUTHENTICATED = 'UNAUTHENTICATED',
  FORBIDDEN = 'FORBIDDEN',
  RATE_LIMITED = 'RATE_LIMITED',
  UPLOAD_VERIFICATION_FAILED = 'UPLOAD_VERIFICATION_FAILED',
  STORAGE_UNAVAILABLE = 'STORAGE_UNAVAILABLE',
  SETTING_INVALID = 'SETTING_INVALID',
  INTERNAL = 'INTERNAL',
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `npx jest src/core/errors/error-codes.spec.ts`
Expected: PASS, 2 tests.

- [ ] **Step 9: Commit**

```bash
git add jest.config.ts test/setup-env.ts src/core/errors/ package.json package-lock.json
git commit -m "test: add jest harness and shared error codes

The repo had @nestjs/testing installed but no runner, so no test could
execute. Every subsequent task is TDD and depends on this.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Global exception filter

Replaces the current pattern where `audio.service.ts` catches everything and rethrows `ServiceUnavailableException`, so a Prisma validation error reports as "database down".

**Files:**
- Create: `src/core/errors/http-exception.filter.ts`
- Create: `src/core/errors/http-exception.filter.spec.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `ErrorCode` from Task 2
- Produces: `AllExceptionsFilter` — registered globally; maps Prisma `P2002 → 409`, `P2025 → 404`, `HttpException → its own status`, everything else → 500

- [ ] **Step 1: Write the failing test**

Create `src/core/errors/http-exception.filter.spec.ts`:

```ts
import { ArgumentsHost, BadRequestException, NotFoundException } from '@nestjs/common';
import { AllExceptionsFilter } from './http-exception.filter';
import { ErrorCode } from './error-codes';

function hostFor(): { host: ArgumentsHost; json: jest.Mock; status: jest.Mock } {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ id: 'trace-123', url: '/x', method: 'GET' }),
    }),
  } as unknown as ArgumentsHost;
  return { host, json, status };
}

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  it('maps Prisma P2002 to 409 CONFLICT', () => {
    const { host, json, status } = hostFor();
    filter.catch({ code: 'P2002', meta: { target: ['slug'] } }, host);
    expect(status).toHaveBeenCalledWith(409);
    expect(json.mock.calls[0][0]).toMatchObject({
      success: false,
      error: { code: ErrorCode.CONFLICT, traceId: 'trace-123' },
    });
  });

  it('maps Prisma P2025 to 404 NOT_FOUND', () => {
    const { host, json, status } = hostFor();
    filter.catch({ code: 'P2025' }, host);
    expect(status).toHaveBeenCalledWith(404);
    expect(json.mock.calls[0][0].error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('preserves an explicit HttpException status', () => {
    const { host, json, status } = hostFor();
    filter.catch(new NotFoundException('gone'), host);
    expect(status).toHaveBeenCalledWith(404);
    expect(json.mock.calls[0][0].error.message).toBe('gone');
  });

  it('maps validation BadRequest to 422 VALIDATION_FAILED', () => {
    const { host, json, status } = hostFor();
    filter.catch(
      new BadRequestException({ message: ['title must be a string'] }),
      host,
    );
    expect(status).toHaveBeenCalledWith(422);
    expect(json.mock.calls[0][0].error.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(json.mock.calls[0][0].error.details).toEqual(['title must be a string']);
  });

  it('never leaks an unknown error message to the client', () => {
    const { host, json, status } = hostFor();
    filter.catch(new Error('connect ECONNREFUSED 10.0.0.5:5432'), host);
    expect(status).toHaveBeenCalledWith(500);
    expect(json.mock.calls[0][0].error.message).toBe('Internal server error');
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain('10.0.0.5');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/core/errors/http-exception.filter.spec.ts`
Expected: FAIL — `Cannot find module './http-exception.filter'`.

- [ ] **Step 3: Write the implementation**

Create `src/core/errors/http-exception.filter.ts`:

```ts
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

import { ErrorCode } from './error-codes';

interface PrismaLikeError {
  code?: string;
  meta?: Record<string, unknown>;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<{ status: (c: number) => { json: (b: unknown) => void } }>();
    const req = http.getRequest<{ id?: string; url?: string; method?: string }>();
    const traceId = req?.id ?? 'unknown';

    const { status, code, message, details } = this.classify(exception);

    if (status >= 500) {
      this.logger.error(
        `${req?.method ?? '?'} ${req?.url ?? '?'} -> ${status} [${traceId}]`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    res.status(status).json({
      success: false,
      error: { code, message, ...(details ? { details } : {}), traceId },
    });
  }

  private classify(exception: unknown): {
    status: number;
    code: ErrorCode;
    message: string;
    details?: unknown;
  } {
    const prisma = exception as PrismaLikeError;

    if (prisma?.code === 'P2002') {
      return {
        status: HttpStatus.CONFLICT,
        code: ErrorCode.CONFLICT,
        message: 'A record with these values already exists.',
        details: prisma.meta?.target,
      };
    }

    if (prisma?.code === 'P2025') {
      return {
        status: HttpStatus.NOT_FOUND,
        code: ErrorCode.NOT_FOUND,
        message: 'The requested record does not exist.',
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const raw = typeof body === 'object' && body !== null
        ? (body as { message?: string | string[] }).message
        : undefined;

      // class-validator failures arrive as BadRequest with a string[] message.
      if (status === HttpStatus.BAD_REQUEST && Array.isArray(raw)) {
        return {
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          code: ErrorCode.VALIDATION_FAILED,
          message: 'Request validation failed.',
          details: raw,
        };
      }

      return {
        status,
        code: this.codeForStatus(status),
        message: Array.isArray(raw) ? raw.join(', ') : raw ?? exception.message,
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL,
      message: 'Internal server error',
    };
  }

  private codeForStatus(status: number): ErrorCode {
    switch (status) {
      case HttpStatus.UNAUTHORIZED:
        return ErrorCode.UNAUTHENTICATED;
      case HttpStatus.FORBIDDEN:
        return ErrorCode.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ErrorCode.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ErrorCode.CONFLICT;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ErrorCode.RATE_LIMITED;
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return ErrorCode.VALIDATION_FAILED;
      default:
        return status >= 500 ? ErrorCode.INTERNAL : ErrorCode.VALIDATION_FAILED;
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/core/errors/http-exception.filter.spec.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Register it globally**

In `src/main.ts`, add the import and register after `useGlobalPipes`:

```ts
import { AllExceptionsFilter } from './core/errors/http-exception.filter';
// …
app.useGlobalFilters(new AllExceptionsFilter());
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/core/errors src/main.ts
git commit -m "feat: add global exception filter with typed error envelope

Replaces the catch-all ServiceUnavailableException pattern, under which a
Prisma validation error surfaced to clients as 'database unavailable'.
Unknown errors no longer leak their message.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Baseline the Prisma migration history

The database was built with `db push`. It has no `_prisma_migrations` table, and `prisma/migrations/` does not exist even though `prisma.config.ts` points at it. The first `migrate dev` would detect drift and offer to reset. This task creates the history deliberately instead.

**Files:**
- Create: `prisma/migrations/0_init/migration.sql`

**Interfaces:**
- Consumes: nothing
- Produces: a migration baseline so every later phase can run `prisma migrate dev` normally

- [ ] **Step 1: Confirm the database has no migration history**

```bash
node -e "require('dotenv').config();const{Client}=require('pg');const c=new Client({connectionString:process.env.DATABASE_URL});c.connect().then(()=>c.query(\"select tablename from pg_tables where schemaname='public'\")).then(r=>{console.log(r.rows.map(x=>x.tablename).join(', '));return c.end()})"
```

Expected: `AudioAsset` only. If `_prisma_migrations` is already present, STOP — the baseline already exists and this task must be skipped.

- [ ] **Step 2: Generate the baseline migration SQL from the current schema**

```bash
mkdir -p prisma/migrations/0_init
npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script > prisma/migrations/0_init/migration.sql
```

- [ ] **Step 3: Verify the SQL describes the existing schema**

```bash
cat prisma/migrations/0_init/migration.sql
```

Expected: `CREATE TYPE "AudioType"`, `CREATE TABLE "AudioAsset"`, and the three indexes from `schema.prisma`. If the file is empty, the `--to-schema` path was wrong — STOP.

- [ ] **Step 4: Record it as already applied**

```bash
npx prisma migrate resolve --applied 0_init
```

Expected: `Migration 0_init marked as applied.`

- [ ] **Step 5: Confirm the history is now clean**

```bash
npx prisma migrate status
```

Expected: "Database schema is up to date!" — not a drift warning.

- [ ] **Step 6: Commit**

```bash
git add prisma/migrations
git commit -m "chore: baseline prisma migration history

The schema was applied with db push, so there was no _prisma_migrations
table and the first migrate dev would have offered to reset. Baselined
deliberately so later phases can migrate normally.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Lint, format, and CI

**Files:**
- Create: `eslint.config.mjs`, `.prettierrc`, `.github/workflows/ci.yml`
- Modify: `package.json`

**Interfaces:**
- Consumes: `npm test` and `npm run typecheck` from Task 2
- Produces: `npm run lint`; CI running typecheck + lint + test on every push

- [ ] **Step 1: Install**

```bash
npm i -D eslint@^9 typescript-eslint@^8 @eslint/js prettier@^3 eslint-config-prettier
```

- [ ] **Step 2: Write `eslint.config.mjs`**

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'src/generated/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'Only DATABASE_URL, MASTER_ENCRYPTION_KEY, PORT and NODE_ENV may come from env. Everything else reads from SettingsService.',
        },
      ],
    },
  },
  {
    files: ['src/core/config/**', 'prisma.config.ts', 'test/**', '**/*.spec.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
);
```

The `no-restricted-properties` rule mechanically enforces the spec's "nothing hardcoded" constraint. The exemption list is the only place `process.env` is legal.

- [ ] **Step 3: Write `.prettierrc`**

```json
{
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 90
}
```

- [ ] **Step 4: Add scripts to `package.json`**

```json
"lint": "eslint src --max-warnings 0",
"format": "prettier --write \"src/**/*.ts\""
```

- [ ] **Step 5: Run lint and fix what it finds**

Run: `npm run lint`

`src/prisma/prisma.service.ts:13` reads `process.env.DATABASE_URL` and will trip the new rule. That read is legitimate — add `src/prisma/**` to the exemption `files` list in `eslint.config.mjs`, then re-run until clean.

- [ ] **Step 6: Write `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm
      - run: npm ci
      - run: npx prisma generate
      - run: npm run typecheck
      - run: npm run lint
      - run: npm test
        env:
          MASTER_ENCRYPTION_KEY: ${{ '0000000000000000000000000000000000000000000000000000000000000000' }}
```

`prisma generate` runs before typecheck because `src/generated/prisma` is gitignored and the build imports from it.

- [ ] **Step 7: Verify the full local gate passes**

```bash
npx prisma generate && npm run typecheck && npm run lint && npm test
```

Expected: all four succeed.

- [ ] **Step 8: Commit**

```bash
git add eslint.config.mjs .prettierrc .github package.json package-lock.json
git commit -m "chore: add eslint, prettier and CI

The no-restricted-properties rule enforces the spec constraint that only
DATABASE_URL, MASTER_ENCRYPTION_KEY, PORT and NODE_ENV may read from env.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

**Phase 0 exit condition:** `npx prisma generate && npm run typecheck && npm run lint && npm test` all pass; `npx prisma migrate status` reports up to date; working tree clean.

---

# Phase 1 — Core platform

## Task 6: Envelope encryption service

Every provider credential and JWT secret in the database is encrypted with this. It is built first because `SystemSetting` and `StorageProvider` both depend on it.

**Files:**
- Create: `src/core/crypto/envelope-crypto.service.ts`
- Create: `src/core/crypto/envelope-crypto.service.spec.ts`
- Create: `src/core/crypto/crypto.module.ts`
- Modify: `eslint.config.mjs`

**Interfaces:**
- Consumes: `MASTER_ENCRYPTION_KEY` env var (64 hex chars = 32 bytes)
- Produces:
  - `interface SealedValue { cipher: Buffer; keyVersion: number }`
  - `EnvelopeCryptoService.encrypt(plaintext: string): SealedValue`
  - `EnvelopeCryptoService.decrypt(sealed: SealedValue): string`
  - `EnvelopeCryptoService.mask(plaintext: string): string`
  - `MASTER_KEY` injection token

- [ ] **Step 1: Write the failing test**

Create `src/core/crypto/envelope-crypto.service.spec.ts`:

```ts
import { EnvelopeCryptoService } from './envelope-crypto.service';

const KEY = 'a'.repeat(64); // 32 bytes hex

describe('EnvelopeCryptoService', () => {
  const svc = new EnvelopeCryptoService(KEY);

  it('round-trips a value', () => {
    const sealed = svc.encrypt('cloudinary-secret-123');
    expect(svc.decrypt(sealed)).toBe('cloudinary-secret-123');
  });

  it('never stores plaintext in the ciphertext buffer', () => {
    const sealed = svc.encrypt('cloudinary-secret-123');
    expect(sealed.cipher.toString('utf8')).not.toContain('cloudinary-secret-123');
  });

  it('produces different ciphertext each time for the same input', () => {
    const a = svc.encrypt('same');
    const b = svc.encrypt('same');
    expect(a.cipher.equals(b.cipher)).toBe(false);
    expect(svc.decrypt(a)).toBe(svc.decrypt(b));
  });

  it('stamps the key version', () => {
    expect(svc.encrypt('x').keyVersion).toBe(1);
  });

  it('rejects tampered ciphertext rather than returning garbage', () => {
    const sealed = svc.encrypt('secret');
    sealed.cipher[sealed.cipher.length - 1] ^= 0xff;
    expect(() => svc.decrypt(sealed)).toThrow();
  });

  it('refuses to construct with a key of the wrong length', () => {
    expect(() => new EnvelopeCryptoService('tooshort')).toThrow(/MASTER_ENCRYPTION_KEY/);
  });

  it('masks a secret for display without revealing it', () => {
    expect(svc.mask('sk_live_abcdef123456')).toBe('sk_live_••••3456');
  });

  it('fully masks a short secret', () => {
    expect(svc.mask('abc')).toBe('••••');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/core/crypto`
Expected: FAIL — `Cannot find module './envelope-crypto.service'`.

- [ ] **Step 3: Write the implementation**

Create `src/core/crypto/envelope-crypto.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const MASTER_KEY = Symbol('MASTER_KEY');

export interface SealedValue {
  cipher: Buffer;
  keyVersion: number;
}

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const CURRENT_KEY_VERSION = 1;

@Injectable()
export class EnvelopeCryptoService {
  private readonly key: Buffer;

  constructor(@Inject(MASTER_KEY) masterKeyHex: string) {
    if (!/^[0-9a-fA-F]{64}$/.test(masterKeyHex)) {
      throw new Error(
        'MASTER_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes).',
      );
    }
    this.key = Buffer.from(masterKeyHex, 'hex');
  }

  /** Layout: [12-byte IV][16-byte auth tag][ciphertext] */
  encrypt(plaintext: string): SealedValue {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      cipher: Buffer.concat([iv, cipher.getAuthTag(), body]),
      keyVersion: CURRENT_KEY_VERSION,
    };
  }

  decrypt(sealed: SealedValue): string {
    const iv = sealed.cipher.subarray(0, IV_BYTES);
    const tag = sealed.cipher.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const body = sealed.cipher.subarray(IV_BYTES + TAG_BYTES);

    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  }

  /** Display form for the admin API. Never reversible. */
  mask(plaintext: string): string {
    if (plaintext.length <= 8) return '••••';
    return `${plaintext.slice(0, 8)}••••${plaintext.slice(-4)}`;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/core/crypto`
Expected: PASS, 8 tests.

- [ ] **Step 5: Write the module**

Create `src/core/crypto/crypto.module.ts`:

```ts
import { Global, Module } from '@nestjs/common';

import { EnvelopeCryptoService, MASTER_KEY } from './envelope-crypto.service';

@Global()
@Module({
  providers: [
    {
      provide: MASTER_KEY,
      useFactory: (): string => {
        const key = process.env.MASTER_ENCRYPTION_KEY;
        if (!key) {
          throw new Error(
            'MASTER_ENCRYPTION_KEY is not set. It cannot live in the database — ' +
              'it is the key that decrypts the database-stored secrets.',
          );
        }
        return key;
      },
    },
    EnvelopeCryptoService,
  ],
  exports: [EnvelopeCryptoService],
})
export class CryptoModule {}
```

- [ ] **Step 6: Exempt this file from the env lint rule**

In `eslint.config.mjs`, add `src/core/crypto/**` to the `files` array of the block that disables `no-restricted-properties`. This factory is one of the three legal `process.env` reads.

- [ ] **Step 7: Verify the gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/core/crypto eslint.config.mjs
git commit -m "feat: add AES-256-GCM envelope encryption for stored secrets

Ciphertext carries its own IV and auth tag, so tampering is detected rather
than silently decrypting to garbage. keyVersion is stamped on every value so
the master key can be rotated by re-wrapping instead of downtime.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Settings registry and service

**Files:**
- Create: `src/core/settings/setting-registry.ts`
- Create: `src/core/settings/setting-registry.spec.ts`
- Create: `src/core/settings/setting-definitions.ts`
- Create: `src/core/settings/settings.service.ts`
- Create: `src/core/settings/settings.service.spec.ts`
- Create: `src/core/settings/settings.module.ts`
- Modify: `prisma/schema.prisma`, `src/app.module.ts`

**Interfaces:**
- Consumes: `EnvelopeCryptoService` (Task 6), `PrismaService`
- Produces:
  - `type SettingType = 'string' | 'int' | 'boolean' | 'string[]' | 'json'`
  - `interface SettingDefinition<T> { key, group, type, default, secret, description?, min?, max?, enum? }`
  - `defineSetting<T>(def: SettingDefinition<T>): SettingDefinition<T>`
  - `validateSetting<T>(def: SettingDefinition<T>, value: unknown): T`
  - `SETTINGS: ReadonlyMap<string, SettingDefinition>`
  - `SettingsService.get<T>(key: string): Promise<T>`
  - `SettingsService.set(key: string, value: unknown, actorId: string): Promise<void>`
  - `SettingsService.getMaskedGroup(group: string): Promise<MaskedSetting[]>`
  - `SettingsService.invalidate(key: string): void`

- [ ] **Step 1: Add the `SystemSetting` model to `prisma/schema.prisma`**

```prisma
model SystemSetting {
  key         String   @id
  group       String
  valueJson   Json?
  valueCipher Bytes?
  keyVersion  Int?
  isSecret    Boolean  @default(false)
  updatedById String?
  updatedAt   DateTime @updatedAt

  @@index([group])
}
```

- [ ] **Step 2: Migrate and regenerate**

```bash
npx prisma migrate dev --name add_system_setting
npx prisma generate
```

Expected: a new folder under `prisma/migrations/` and no reset prompt — Task 4 baselined the history. If a reset is offered, STOP; the baseline did not take.

- [ ] **Step 3: Write the failing registry test**

Create `src/core/settings/setting-registry.spec.ts`:

```ts
import { defineSetting, validateSetting } from './setting-registry';

describe('setting registry', () => {
  const maxBytes = defineSetting({
    key: 'upload.audio.maxBytes',
    group: 'upload',
    type: 'int',
    default: 52_428_800,
    secret: false,
    min: 1,
    max: 1_073_741_824,
  });

  it('accepts a value inside the declared range', () => {
    expect(validateSetting(maxBytes, 1000)).toBe(1000);
  });

  it('rejects a value below the minimum', () => {
    expect(() => validateSetting(maxBytes, 0)).toThrow(/at least 1/);
  });

  it('rejects a value above the maximum', () => {
    expect(() => validateSetting(maxBytes, 2_000_000_000)).toThrow(/at most/);
  });

  it('rejects the wrong primitive type', () => {
    expect(() => validateSetting(maxBytes, 'big')).toThrow(/expected int/);
  });

  it('rejects a non-integer number for an int setting', () => {
    expect(() => validateSetting(maxBytes, 1.5)).toThrow(/expected int/);
  });

  it('validates each element of a string list', () => {
    const mimes = defineSetting({
      key: 'upload.audio.mimeTypes',
      group: 'upload',
      type: 'string[]',
      default: ['audio/mpeg'],
      secret: false,
    });
    expect(validateSetting(mimes, ['audio/wav'])).toEqual(['audio/wav']);
    expect(() => validateSetting(mimes, [1])).toThrow(/expected string\[\]/);
  });

  it('enforces an enum when one is declared', () => {
    const provider = defineSetting({
      key: 'storage.defaultKind',
      group: 'storage',
      type: 'string',
      default: 'cloudinary',
      secret: false,
      enum: ['cloudinary', 's3'] as const,
    });
    expect(validateSetting(provider, 's3')).toBe('s3');
    expect(() => validateSetting(provider, 'ftp')).toThrow(/must be one of/);
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `npx jest src/core/settings/setting-registry.spec.ts`
Expected: FAIL — `Cannot find module './setting-registry'`.

- [ ] **Step 5: Write `src/core/settings/setting-registry.ts`**

```ts
export type SettingType = 'string' | 'int' | 'boolean' | 'string[]' | 'json';

export interface SettingDefinition<T = unknown> {
  key: string;
  group: string;
  type: SettingType;
  default: T;
  secret: boolean;
  description?: string;
  min?: number;
  max?: number;
  enum?: readonly string[];
}

export function defineSetting<T>(def: SettingDefinition<T>): SettingDefinition<T> {
  return Object.freeze(def);
}

export function validateSetting<T>(def: SettingDefinition<T>, value: unknown): T {
  switch (def.type) {
    case 'int': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new Error(`${def.key}: expected int, got ${typeof value}`);
      }
      if (def.min !== undefined && value < def.min) {
        throw new Error(`${def.key}: must be at least ${def.min}`);
      }
      if (def.max !== undefined && value > def.max) {
        throw new Error(`${def.key}: must be at most ${def.max}`);
      }
      return value as T;
    }
    case 'string': {
      if (typeof value !== 'string') {
        throw new Error(`${def.key}: expected string, got ${typeof value}`);
      }
      if (def.enum && !def.enum.includes(value)) {
        throw new Error(`${def.key}: must be one of ${def.enum.join(', ')}`);
      }
      return value as T;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        throw new Error(`${def.key}: expected boolean, got ${typeof value}`);
      }
      return value as T;
    }
    case 'string[]': {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        throw new Error(`${def.key}: expected string[]`);
      }
      return value as T;
    }
    case 'json': {
      if (value === null || typeof value !== 'object') {
        throw new Error(`${def.key}: expected json object`);
      }
      return value as T;
    }
  }
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx jest src/core/settings/setting-registry.spec.ts`
Expected: PASS, 7 tests.

- [ ] **Step 7: Write `src/core/settings/setting-definitions.ts`**

This is every setting Phases 0–3 need. Later phases append to the array.

```ts
import { defineSetting, SettingDefinition } from './setting-registry';

export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  defineSetting({
    key: 'upload.audio.maxBytes',
    group: 'upload',
    type: 'int',
    default: 52_428_800,
    secret: false,
    min: 1,
    max: 1_073_741_824,
    description: 'Largest audio file an admin may upload, in bytes.',
  }),
  defineSetting({
    key: 'upload.audio.mimeTypes',
    group: 'upload',
    type: 'string[]',
    default: ['audio/mpeg', 'audio/wav', 'audio/aac', 'audio/ogg', 'audio/flac'],
    secret: false,
    description: 'MIME types accepted for audio uploads.',
  }),
  defineSetting({
    key: 'upload.ticketTtlSeconds',
    group: 'upload',
    type: 'int',
    default: 900,
    secret: false,
    min: 60,
    max: 86_400,
    description: 'How long a signed upload ticket stays valid.',
  }),
  defineSetting({
    key: 'auth.accessTokenTtlSeconds',
    group: 'auth',
    type: 'int',
    default: 900,
    secret: false,
    min: 60,
    max: 3_600,
  }),
  defineSetting({
    key: 'auth.refreshTokenTtlSeconds',
    group: 'auth',
    type: 'int',
    default: 604_800,
    secret: false,
    min: 3_600,
    max: 7_776_000,
  }),
  defineSetting({
    key: 'auth.jwtAccessSecret',
    group: 'auth',
    type: 'string',
    default: '',
    secret: true,
    description: 'Signing secret for access tokens. Generated on first boot.',
  }),
  defineSetting({
    key: 'auth.loginMaxAttempts',
    group: 'auth',
    type: 'int',
    default: 5,
    secret: false,
    min: 1,
    max: 100,
  }),
  defineSetting({
    key: 'auth.loginLockoutSeconds',
    group: 'auth',
    type: 'int',
    default: 900,
    secret: false,
    min: 30,
    max: 86_400,
  }),
  defineSetting({
    key: 'cors.allowedOrigins',
    group: 'security',
    type: 'string[]',
    default: [],
    secret: false,
    description: 'Empty means allow all — acceptable only for the public read API.',
  }),
];

export const SETTINGS: ReadonlyMap<string, SettingDefinition> = new Map(
  SETTING_DEFINITIONS.map((d) => [d.key, d]),
);
```

- [ ] **Step 8: Write the failing service test**

Create `src/core/settings/settings.service.spec.ts`:

```ts
import { EnvelopeCryptoService } from '../crypto/envelope-crypto.service';
import { SettingsService } from './settings.service';

const KEY = 'b'.repeat(64);

function prismaMock() {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    systemSetting: {
      findUnique: jest.fn(async ({ where }: { where: { key: string } }) =>
        rows.get(where.key) ?? null,
      ),
      upsert: jest.fn(
        async ({
          where,
          create,
        }: {
          where: { key: string };
          create: Record<string, unknown>;
        }) => {
          rows.set(where.key, create);
          return create;
        },
      ),
    },
  };
}

describe('SettingsService', () => {
  const crypto = new EnvelopeCryptoService(KEY);

  it('returns the registry default when no row exists', async () => {
    const svc = new SettingsService(prismaMock() as never, crypto);
    await expect(svc.get('upload.audio.maxBytes')).resolves.toBe(52_428_800);
  });

  it('returns a stored non-secret value over the default', async () => {
    const svc = new SettingsService(prismaMock() as never, crypto);
    await svc.set('upload.audio.maxBytes', 1234, 'admin-1');
    await expect(svc.get('upload.audio.maxBytes')).resolves.toBe(1234);
  });

  it('encrypts a secret on write and decrypts it on read', async () => {
    const prisma = prismaMock();
    const svc = new SettingsService(prisma as never, crypto);
    await svc.set('auth.jwtAccessSecret', 'super-secret', 'admin-1');

    const row = prisma.rows.get('auth.jwtAccessSecret')!;
    expect(row.valueJson).toBeNull();
    expect((row.valueCipher as Buffer).toString('utf8')).not.toContain('super-secret');

    await expect(svc.get('auth.jwtAccessSecret')).resolves.toBe('super-secret');
  });

  it('rejects a value that fails the registry validator and writes nothing', async () => {
    const prisma = prismaMock();
    const svc = new SettingsService(prisma as never, crypto);
    await expect(svc.set('upload.audio.maxBytes', -1, 'admin-1')).rejects.toThrow(
      /at least 1/,
    );
    expect(prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });

  it('rejects an unknown setting key', async () => {
    const svc = new SettingsService(prismaMock() as never, crypto);
    await expect(svc.set('nope.not.real', 1, 'admin-1')).rejects.toThrow(
      /unknown setting/i,
    );
  });

  it('masks secrets when listing a group', async () => {
    const svc = new SettingsService(prismaMock() as never, crypto);
    await svc.set('auth.jwtAccessSecret', 'sk_live_abcdef123456', 'admin-1');

    const listed = await svc.getMaskedGroup('auth');
    const secret = listed.find((s) => s.key === 'auth.jwtAccessSecret')!;
    expect(secret.value).toBe('sk_live_••••3456');
    expect(secret.isSecret).toBe(true);
  });

  it('never returns a raw secret from getMaskedGroup', async () => {
    const svc = new SettingsService(prismaMock() as never, crypto);
    await svc.set('auth.jwtAccessSecret', 'sk_live_abcdef123456', 'admin-1');
    const listed = await svc.getMaskedGroup('auth');
    expect(JSON.stringify(listed)).not.toContain('abcdef12');
  });

  it('caches a read and does not hit the database twice', async () => {
    const prisma = prismaMock();
    const svc = new SettingsService(prisma as never, crypto);
    await svc.get('upload.ticketTtlSeconds');
    await svc.get('upload.ticketTtlSeconds');
    expect(prisma.systemSetting.findUnique).toHaveBeenCalledTimes(1);
  });

  it('invalidates the cache on write', async () => {
    const svc = new SettingsService(prismaMock() as never, crypto);
    await svc.get('upload.ticketTtlSeconds');
    await svc.set('upload.ticketTtlSeconds', 300, 'admin-1');
    await expect(svc.get('upload.ticketTtlSeconds')).resolves.toBe(300);
  });
});
```

- [ ] **Step 9: Run to verify it fails**

Run: `npx jest src/core/settings/settings.service.spec.ts`
Expected: FAIL — `Cannot find module './settings.service'`.

- [ ] **Step 10: Write `src/core/settings/settings.service.ts`**

```ts
import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { EnvelopeCryptoService } from '../crypto/envelope-crypto.service';
import { SETTINGS } from './setting-definitions';
import { SettingDefinition, validateSetting } from './setting-registry';

export interface MaskedSetting {
  key: string;
  group: string;
  type: string;
  isSecret: boolean;
  value: unknown;
  description?: string;
}

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private readonly cache = new Map<string, unknown>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: EnvelopeCryptoService,
  ) {}

  async get<T = unknown>(key: string): Promise<T> {
    if (this.cache.has(key)) return this.cache.get(key) as T;

    const def = this.definition(key);
    const row = await this.prisma.systemSetting.findUnique({ where: { key } });

    let value: unknown;
    if (!row) {
      value = def.default;
    } else if (def.secret) {
      value = row.valueCipher
        ? this.crypto.decrypt({
            cipher: Buffer.from(row.valueCipher),
            keyVersion: row.keyVersion ?? 1,
          })
        : def.default;
    } else {
      value = row.valueJson ?? def.default;
    }

    this.cache.set(key, value);
    return value as T;
  }

  async set(key: string, value: unknown, actorId: string): Promise<void> {
    const def = this.definition(key);
    const validated = validateSetting(def, value);

    const payload = def.secret
      ? this.sealed(validated)
      : { valueJson: validated as never, valueCipher: null, keyVersion: null };

    const record = {
      key,
      group: def.group,
      isSecret: def.secret,
      updatedById: actorId,
      ...payload,
    };

    await this.prisma.systemSetting.upsert({
      where: { key },
      create: record,
      update: record,
    });

    this.invalidate(key);
    this.logger.log(`setting ${key} updated by ${actorId}`);
  }

  async getMaskedGroup(group: string): Promise<MaskedSetting[]> {
    const defs = [...SETTINGS.values()].filter((d) => d.group === group);
    return Promise.all(
      defs.map(async (def) => {
        const raw = await this.get(def.key);
        return {
          key: def.key,
          group: def.group,
          type: def.type,
          isSecret: def.secret,
          description: def.description,
          value: def.secret ? this.crypto.mask(String(raw)) : raw,
        };
      }),
    );
  }

  /** Called by the Redis pub/sub subscriber so every instance drops its copy. */
  invalidate(key: string): void {
    this.cache.delete(key);
  }

  private sealed(value: unknown) {
    const sealed = this.crypto.encrypt(String(value));
    return {
      valueJson: null,
      valueCipher: sealed.cipher,
      keyVersion: sealed.keyVersion,
    };
  }

  private definition(key: string): SettingDefinition {
    const def = SETTINGS.get(key);
    if (!def) throw new Error(`Unknown setting key: ${key}`);
    return def;
  }
}
```

- [ ] **Step 11: Run to verify it passes**

Run: `npx jest src/core/settings`
Expected: PASS, 16 tests across both spec files.

- [ ] **Step 12: Write `src/core/settings/settings.module.ts`**

```ts
import { Global, Module } from '@nestjs/common';

import { CryptoModule } from '../crypto/crypto.module';
import { SettingsService } from './settings.service';

@Global()
@Module({
  imports: [CryptoModule],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
```

- [ ] **Step 13: Register both modules in `src/app.module.ts`**

Add `CryptoModule` and `SettingsModule` to the `imports` array, after `PrismaModule`.

- [ ] **Step 14: Verify the gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all exit 0.

- [ ] **Step 15: Commit**

```bash
git add src/core/settings src/app.module.ts prisma/schema.prisma prisma/migrations
git commit -m "feat: add DB-backed settings with a code-owned schema

Values live in SystemSetting; the registry in code declares which keys exist
and validates every write, so an admin can change configuration at runtime
without being able to store a value that bricks the server. Secrets are
encrypted at rest and only ever returned masked.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: Storage adapter interface and Cloudinary implementation

This is the task that closes the trust hole in the current code. Today `mapDirectUploadResult` copies client-supplied `durationSeconds`, `fileSizeBytes`, `previewUrl` and `downloadUrl` straight into the database with no verification that the upload even happened. `verifyUpload` replaces all of that.

**Files:**
- Create: `src/core/storage/storage-adapter.interface.ts`
- Create: `src/core/storage/adapters/cloudinary.adapter.ts`
- Create: `src/core/storage/adapters/cloudinary.adapter.spec.ts`
- Create: `src/core/storage/storage.registry.ts`
- Create: `src/core/storage/storage.registry.spec.ts`
- Create: `src/core/storage/storage.module.ts`
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Consumes: `EnvelopeCryptoService` (Task 6), `PrismaService`
- Produces:
  - `interface UploadTicketInput { folder: string; filename: string; mimeType: string; ttlSeconds: number }`
  - `interface UploadTicket { uploadUrl: string; storageKey: string; fields: Record<string, string>; expiresAt: Date }`
  - `interface RemoteObject { storageKey: string; byteSize: number; format: string; mimeType: string; durationMs?: number; width?: number; height?: number; checksumSha256?: string; deliveryUrl: string }`
  - `interface StorageProviderAdapter` with `id`, `kind`, `createUploadTicket`, `verifyUpload`, `getDeliveryUrl`, `getSignedUrl`, `delete`
  - `StorageRegistry.getDefault(): Promise<StorageProviderAdapter>`
  - `StorageRegistry.get(id: string): Promise<StorageProviderAdapter>`
  - `StorageRegistry.invalidate(id?: string): void`

- [ ] **Step 1: Add the `StorageProvider` model and `StorageKind` enum to `prisma/schema.prisma`**

```prisma
enum StorageKind {
  cloudinary
  s3
  r2
  bunny
}

model StorageProvider {
  id           String      @id @default(cuid())
  kind         StorageKind
  name         String      @unique
  isDefault    Boolean     @default(false)
  isActive     Boolean     @default(true)
  configCipher Bytes
  keyVersion   Int         @default(1)
  publicConfig Json?
  lastTestedAt DateTime?
  createdAt    DateTime    @default(now())
  updatedAt    DateTime    @updatedAt
}
```

- [ ] **Step 2: Migrate and regenerate**

```bash
npx prisma migrate dev --name add_storage_provider
npx prisma generate
```

- [ ] **Step 3: Write `src/core/storage/storage-adapter.interface.ts`**

No test for this file — it is types only.

```ts
import { StorageKind } from '../../generated/prisma/enums';

export interface UploadTicketInput {
  folder: string;
  filename: string;
  mimeType: string;
  ttlSeconds: number;
}

export interface UploadTicket {
  uploadUrl: string;
  storageKey: string;
  fields: Record<string, string>;
  expiresAt: Date;
}

/** Authoritative metadata read back from the provider after an upload. */
export interface RemoteObject {
  storageKey: string;
  byteSize: number;
  format: string;
  mimeType: string;
  durationMs?: number;
  width?: number;
  height?: number;
  checksumSha256?: string;
  deliveryUrl: string;
}

export interface StorageProviderAdapter {
  readonly id: string;
  readonly kind: StorageKind;
  createUploadTicket(input: UploadTicketInput): Promise<UploadTicket>;
  verifyUpload(storageKey: string): Promise<RemoteObject>;
  getDeliveryUrl(storageKey: string): string;
  getSignedUrl(storageKey: string, ttlSeconds: number): Promise<string>;
  delete(storageKey: string): Promise<void>;
}

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  folder: string;
}
```

- [ ] **Step 4: Write the failing Cloudinary adapter test**

Create `src/core/storage/adapters/cloudinary.adapter.spec.ts`. The `cloudinary` SDK is mocked so the test never makes a network call.

```ts
const mockApiSignRequest = jest.fn().mockReturnValue('signed-abc');
const mockResource = jest.fn();
const mockDestroy = jest.fn();
const mockUrl = jest.fn().mockReturnValue('https://res.cloudinary.com/demo/x.mp3');

jest.mock('cloudinary', () => ({
  v2: {
    config: jest.fn(),
    url: (...args: unknown[]) => mockUrl(...args),
    utils: { api_sign_request: (...a: unknown[]) => mockApiSignRequest(...a) },
    api: { resource: (...a: unknown[]) => mockResource(...a) },
    uploader: { destroy: (...a: unknown[]) => mockDestroy(...a) },
  },
}));

import { CloudinaryAdapter } from './cloudinary.adapter';

const CONFIG = {
  cloudName: 'demo',
  apiKey: 'key-1',
  apiSecret: 'secret-1',
  folder: 'slimshot/audio',
};

describe('CloudinaryAdapter', () => {
  beforeEach(() => jest.clearAllMocks());

  const adapter = new CloudinaryAdapter('prov-1', CONFIG);

  it('issues a ticket whose storage key is scoped to the configured folder', async () => {
    const ticket = await adapter.createUploadTicket({
      folder: 'slimshot/audio',
      filename: 'Rise Up.mp3',
      mimeType: 'audio/mpeg',
      ttlSeconds: 900,
    });

    expect(ticket.storageKey.startsWith('slimshot/audio/')).toBe(true);
    expect(ticket.uploadUrl).toContain('/demo/');
    expect(ticket.fields.signature).toBe('signed-abc');
    expect(ticket.fields.api_key).toBe('key-1');
  });

  it('never leaks the api secret into the ticket handed to the browser', async () => {
    const ticket = await adapter.createUploadTicket({
      folder: 'slimshot/audio',
      filename: 'a.mp3',
      mimeType: 'audio/mpeg',
      ttlSeconds: 900,
    });
    expect(JSON.stringify(ticket)).not.toContain('secret-1');
  });

  it('sets an expiry derived from the requested ttl', async () => {
    const before = Date.now();
    const ticket = await adapter.createUploadTicket({
      folder: 'slimshot/audio',
      filename: 'a.mp3',
      mimeType: 'audio/mpeg',
      ttlSeconds: 600,
    });
    expect(ticket.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 600_000 - 2_000);
    expect(ticket.expiresAt.getTime()).toBeLessThanOrEqual(before + 600_000 + 2_000);
  });

  it('reads authoritative metadata from the provider, converting seconds to ms', async () => {
    mockResource.mockResolvedValue({
      public_id: 'slimshot/audio/rise',
      bytes: 812_340,
      format: 'mp3',
      duration: 145.2,
      secure_url: 'https://res.cloudinary.com/demo/rise.mp3',
      resource_type: 'video',
    });

    const obj = await adapter.verifyUpload('slimshot/audio/rise');

    expect(obj.byteSize).toBe(812_340);
    expect(obj.durationMs).toBe(145_200);
    expect(obj.format).toBe('mp3');
    expect(obj.deliveryUrl).toBe('https://res.cloudinary.com/demo/rise.mp3');
  });

  it('throws when the object does not exist, so finalize cannot invent a row', async () => {
    mockResource.mockRejectedValue({ http_code: 404, message: 'Not Found' });
    await expect(adapter.verifyUpload('slimshot/audio/ghost')).rejects.toThrow(
      /not found/i,
    );
  });

  it('omits durationMs for an object that has no duration', async () => {
    mockResource.mockResolvedValue({
      public_id: 'slimshot/img/cover',
      bytes: 4_210,
      format: 'jpg',
      secure_url: 'https://res.cloudinary.com/demo/cover.jpg',
      resource_type: 'image',
      width: 800,
      height: 800,
    });

    const obj = await adapter.verifyUpload('slimshot/img/cover');
    expect(obj.durationMs).toBeUndefined();
    expect(obj.width).toBe(800);
  });

  it('deletes through the uploader', async () => {
    mockDestroy.mockResolvedValue({ result: 'ok' });
    await adapter.delete('slimshot/audio/rise');
    expect(mockDestroy).toHaveBeenCalledWith('slimshot/audio/rise', {
      resource_type: 'video',
      invalidate: true,
    });
  });
});
```

- [ ] **Step 5: Run to verify it fails**

Run: `npx jest src/core/storage/adapters`
Expected: FAIL — `Cannot find module './cloudinary.adapter'`.

- [ ] **Step 6: Write `src/core/storage/adapters/cloudinary.adapter.ts`**

```ts
import { v2 as cloudinary } from 'cloudinary';
import { randomUUID } from 'node:crypto';

import { StorageKind } from '../../../generated/prisma/enums';
import {
  CloudinaryConfig,
  RemoteObject,
  StorageProviderAdapter,
  UploadTicket,
  UploadTicketInput,
} from '../storage-adapter.interface';

interface CloudinaryResource {
  public_id: string;
  bytes: number;
  format: string;
  duration?: number;
  width?: number;
  height?: number;
  secure_url: string;
  resource_type: string;
  etag?: string;
}

/**
 * Cloudinary stores audio under resource_type "video". That is a Cloudinary
 * quirk, not a mistake — audio and video share the same pipeline there.
 */
const RESOURCE_TYPE = 'video';

export class CloudinaryAdapter implements StorageProviderAdapter {
  readonly kind = StorageKind.cloudinary;

  constructor(
    readonly id: string,
    private readonly config: CloudinaryConfig,
  ) {
    cloudinary.config({
      cloud_name: config.cloudName,
      api_key: config.apiKey,
      api_secret: config.apiSecret,
      secure: true,
    });
  }

  async createUploadTicket(input: UploadTicketInput): Promise<UploadTicket> {
    const timestamp = Math.floor(Date.now() / 1000);
    const publicId = `${input.folder}/${randomUUID()}`;

    // Every signed param is pinned, so a holder of this ticket cannot widen
    // the upload beyond the exact object we expect.
    const params: Record<string, string | number> = {
      public_id: publicId,
      timestamp,
      overwrite: 'false',
    };

    const signature = cloudinary.utils.api_sign_request(params, this.config.apiSecret);

    return {
      uploadUrl: `https://api.cloudinary.com/v1_1/${this.config.cloudName}/${RESOURCE_TYPE}/upload`,
      storageKey: publicId,
      fields: {
        public_id: publicId,
        timestamp: String(timestamp),
        overwrite: 'false',
        api_key: this.config.apiKey,
        signature,
      },
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000),
    };
  }

  async verifyUpload(storageKey: string): Promise<RemoteObject> {
    let resource: CloudinaryResource;
    try {
      resource = (await cloudinary.api.resource(storageKey, {
        resource_type: RESOURCE_TYPE,
      })) as CloudinaryResource;
    } catch (error) {
      const code = (error as { http_code?: number }).http_code;
      if (code === 404) {
        throw new Error(`Uploaded object not found in storage: ${storageKey}`);
      }
      throw error;
    }

    return {
      storageKey: resource.public_id,
      byteSize: resource.bytes,
      format: resource.format,
      mimeType: `audio/${resource.format}`,
      ...(resource.duration !== undefined
        ? { durationMs: Math.round(resource.duration * 1000) }
        : {}),
      ...(resource.width !== undefined ? { width: resource.width } : {}),
      ...(resource.height !== undefined ? { height: resource.height } : {}),
      deliveryUrl: resource.secure_url,
    };
  }

  getDeliveryUrl(storageKey: string): string {
    return cloudinary.url(storageKey, {
      resource_type: RESOURCE_TYPE,
      secure: true,
    });
  }

  async getSignedUrl(storageKey: string, ttlSeconds: number): Promise<string> {
    return cloudinary.url(storageKey, {
      resource_type: RESOURCE_TYPE,
      secure: true,
      sign_url: true,
      type: 'authenticated',
      expires_at: Math.floor(Date.now() / 1000) + ttlSeconds,
    });
  }

  async delete(storageKey: string): Promise<void> {
    await cloudinary.uploader.destroy(storageKey, {
      resource_type: RESOURCE_TYPE,
      invalidate: true,
    });
  }
}
```

- [ ] **Step 7: Run to verify it passes**

Run: `npx jest src/core/storage/adapters`
Expected: PASS, 7 tests.

- [ ] **Step 8: Write the failing registry test**

Create `src/core/storage/storage.registry.spec.ts`:

```ts
jest.mock('cloudinary', () => ({
  v2: { config: jest.fn(), url: jest.fn(), utils: {}, api: {}, uploader: {} },
}));

import { EnvelopeCryptoService } from '../crypto/envelope-crypto.service';
import { StorageRegistry } from './storage.registry';

const KEY = 'c'.repeat(64);
const crypto = new EnvelopeCryptoService(KEY);

const CONFIG = JSON.stringify({
  cloudName: 'demo',
  apiKey: 'key-1',
  apiSecret: 'secret-1',
  folder: 'slimshot/audio',
});

function prismaWith(rows: Array<Record<string, unknown>>) {
  return {
    storageProvider: {
      findFirst: jest.fn(async () => rows.find((r) => r.isDefault) ?? null),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        rows.find((r) => r.id === where.id) ?? null,
      ),
    },
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prov-1',
    kind: 'cloudinary',
    name: 'Primary',
    isDefault: true,
    isActive: true,
    configCipher: crypto.encrypt(CONFIG).cipher,
    keyVersion: 1,
    ...overrides,
  };
}

describe('StorageRegistry', () => {
  it('builds an adapter from the default provider row', async () => {
    const reg = new StorageRegistry(prismaWith([row()]) as never, crypto);
    const adapter = await reg.getDefault();
    expect(adapter.id).toBe('prov-1');
    expect(adapter.kind).toBe('cloudinary');
  });

  it('caches the adapter instead of decrypting on every call', async () => {
    const prisma = prismaWith([row()]);
    const reg = new StorageRegistry(prisma as never, crypto);
    await reg.getDefault();
    await reg.getDefault();
    expect(prisma.storageProvider.findFirst).toHaveBeenCalledTimes(1);
  });

  it('rebuilds the adapter after invalidation', async () => {
    const prisma = prismaWith([row()]);
    const reg = new StorageRegistry(prisma as never, crypto);
    await reg.getDefault();
    reg.invalidate();
    await reg.getDefault();
    expect(prisma.storageProvider.findFirst).toHaveBeenCalledTimes(2);
  });

  it('throws a clear error when no default provider is configured', async () => {
    const reg = new StorageRegistry(prismaWith([]) as never, crypto);
    await expect(reg.getDefault()).rejects.toThrow(/no default storage provider/i);
  });

  it('resolves a specific provider by id, so old files keep working', async () => {
    const rows = [row(), row({ id: 'prov-2', name: 'Old', isDefault: false })];
    const reg = new StorageRegistry(prismaWith(rows) as never, crypto);
    const adapter = await reg.get('prov-2');
    expect(adapter.id).toBe('prov-2');
  });

  it('refuses an unsupported provider kind rather than failing silently', async () => {
    const reg = new StorageRegistry(
      prismaWith([row({ kind: 'bunny' })]) as never,
      crypto,
    );
    await expect(reg.getDefault()).rejects.toThrow(/unsupported storage kind: bunny/i);
  });
});
```

- [ ] **Step 9: Run to verify it fails**

Run: `npx jest src/core/storage/storage.registry.spec.ts`
Expected: FAIL — `Cannot find module './storage.registry'`.

- [ ] **Step 10: Write `src/core/storage/storage.registry.ts`**

```ts
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { EnvelopeCryptoService } from '../crypto/envelope-crypto.service';
import { CloudinaryAdapter } from './adapters/cloudinary.adapter';
import {
  CloudinaryConfig,
  StorageProviderAdapter,
} from './storage-adapter.interface';

interface ProviderRow {
  id: string;
  kind: string;
  configCipher: Uint8Array;
  keyVersion: number;
}

@Injectable()
export class StorageRegistry {
  private readonly adapters = new Map<string, StorageProviderAdapter>();
  private defaultId?: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: EnvelopeCryptoService,
  ) {}

  async getDefault(): Promise<StorageProviderAdapter> {
    if (this.defaultId) {
      const cached = this.adapters.get(this.defaultId);
      if (cached) return cached;
    }

    const row = (await this.prisma.storageProvider.findFirst({
      where: { isDefault: true, isActive: true },
    })) as ProviderRow | null;

    if (!row) {
      throw new Error(
        'No default storage provider is configured. Create one via the admin API.',
      );
    }

    const adapter = this.build(row);
    this.defaultId = row.id;
    this.adapters.set(row.id, adapter);
    return adapter;
  }

  async get(id: string): Promise<StorageProviderAdapter> {
    const cached = this.adapters.get(id);
    if (cached) return cached;

    const row = (await this.prisma.storageProvider.findUnique({
      where: { id },
    })) as ProviderRow | null;

    if (!row) throw new Error(`Storage provider not found: ${id}`);

    const adapter = this.build(row);
    this.adapters.set(id, adapter);
    return adapter;
  }

  /** Drop cached clients after an admin edits provider config. */
  invalidate(id?: string): void {
    if (id) {
      this.adapters.delete(id);
      if (this.defaultId === id) this.defaultId = undefined;
      return;
    }
    this.adapters.clear();
    this.defaultId = undefined;
  }

  private build(row: ProviderRow): StorageProviderAdapter {
    const json = this.crypto.decrypt({
      cipher: Buffer.from(row.configCipher),
      keyVersion: row.keyVersion,
    });

    switch (row.kind) {
      case 'cloudinary':
        return new CloudinaryAdapter(row.id, JSON.parse(json) as CloudinaryConfig);
      default:
        throw new Error(`Unsupported storage kind: ${row.kind}`);
    }
  }
}
```

- [ ] **Step 11: Run to verify it passes**

Run: `npx jest src/core/storage`
Expected: PASS, 13 tests across both spec files.

- [ ] **Step 12: Write `src/core/storage/storage.module.ts`**

```ts
import { Global, Module } from '@nestjs/common';

import { CryptoModule } from '../crypto/crypto.module';
import { StorageRegistry } from './storage.registry';

@Global()
@Module({
  imports: [CryptoModule],
  providers: [StorageRegistry],
  exports: [StorageRegistry],
})
export class StorageModule {}
```

Register `StorageModule` in `src/app.module.ts`.

- [ ] **Step 13: Verify the gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all exit 0.

- [ ] **Step 14: Commit**

```bash
git add src/core/storage src/app.module.ts prisma/schema.prisma prisma/migrations
git commit -m "feat: add storage adapter abstraction with Cloudinary implementation

verifyUpload reads byte size, format and duration back from the provider,
which is what lets finalize stop trusting client-supplied metadata. Adapters
are built from encrypted DB config and cached per provider id, so changing
the default provider never orphans existing files.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 9: Redis cache with generation-counter invalidation

The spec's invalidation technique: every cache key embeds a per-kind generation counter, so publishing an asset bumps one integer and orphans every stale entry for that kind at once. This replaces the current `@CacheTTL(60 * 60 * 24)` on search, under which a newly uploaded track stays invisible for a day.

**Files:**
- Create: `src/core/cache/cache.service.ts`
- Create: `src/core/cache/cache.service.spec.ts`
- Create: `src/core/cache/redis.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `ioredis`
- Produces:
  - `REDIS` injection token (an `ioredis` client)
  - `CacheService.wrap<T>(namespace: string, keyParts: unknown, factory: () => Promise<T>, ttlSeconds: number): Promise<T>`
  - `CacheService.bumpGeneration(namespace: string): Promise<void>`
  - `CacheService.del(namespace: string, keyParts: unknown): Promise<void>`

- [ ] **Step 1: Install Redis client**

```bash
npm i ioredis@^5
```

- [ ] **Step 2: Write the failing test**

Create `src/core/cache/cache.service.spec.ts`. An in-memory fake stands in for Redis so the test needs no server.

```ts
import { CacheService } from './cache.service';

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    }),
    del: jest.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
    incr: jest.fn(async (k: string) => {
      const next = Number(store.get(k) ?? '0') + 1;
      store.set(k, String(next));
      return next;
    }),
  };
}

describe('CacheService', () => {
  it('calls the factory on a miss and returns its value', async () => {
    const svc = new CacheService(fakeRedis() as never);
    const factory = jest.fn().mockResolvedValue({ n: 1 });
    await expect(svc.wrap('audio', { page: 1 }, factory, 60)).resolves.toEqual({ n: 1 });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('does not call the factory twice for the same key', async () => {
    const svc = new CacheService(fakeRedis() as never);
    const factory = jest.fn().mockResolvedValue({ n: 1 });
    await svc.wrap('audio', { page: 1 }, factory, 60);
    await svc.wrap('audio', { page: 1 }, factory, 60);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('treats different key parts as different entries', async () => {
    const svc = new CacheService(fakeRedis() as never);
    const factory = jest.fn().mockResolvedValue({ n: 1 });
    await svc.wrap('audio', { page: 1 }, factory, 60);
    await svc.wrap('audio', { page: 2 }, factory, 60);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('is insensitive to key-part property order', async () => {
    const svc = new CacheService(fakeRedis() as never);
    const factory = jest.fn().mockResolvedValue({ n: 1 });
    await svc.wrap('audio', { a: 1, b: 2 }, factory, 60);
    await svc.wrap('audio', { b: 2, a: 1 }, factory, 60);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('orphans every entry in a namespace when the generation is bumped', async () => {
    const svc = new CacheService(fakeRedis() as never);
    const factory = jest.fn().mockResolvedValue({ n: 1 });

    await svc.wrap('audio', { page: 1 }, factory, 60);
    await svc.bumpGeneration('audio');
    await svc.wrap('audio', { page: 1 }, factory, 60);

    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('bumping one namespace leaves another namespace cached', async () => {
    const svc = new CacheService(fakeRedis() as never);
    const audio = jest.fn().mockResolvedValue({ n: 1 });
    const fonts = jest.fn().mockResolvedValue({ n: 2 });

    await svc.wrap('audio', { page: 1 }, audio, 60);
    await svc.wrap('font', { page: 1 }, fonts, 60);
    await svc.bumpGeneration('audio');
    await svc.wrap('font', { page: 1 }, fonts, 60);

    expect(fonts).toHaveBeenCalledTimes(1);
  });

  it('returns the factory value rather than throwing when redis read fails', async () => {
    const redis = fakeRedis();
    redis.get.mockRejectedValue(new Error('ECONNREFUSED'));
    const svc = new CacheService(redis as never);
    const factory = jest.fn().mockResolvedValue({ n: 9 });

    await expect(svc.wrap('audio', { page: 1 }, factory, 60)).resolves.toEqual({ n: 9 });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx jest src/core/cache`
Expected: FAIL — `Cannot find module './cache.service'`.

- [ ] **Step 4: Write `src/core/cache/cache.service.ts`**

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { createHash } from 'node:crypto';

export const REDIS = Symbol('REDIS');

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async wrap<T>(
    namespace: string,
    keyParts: unknown,
    factory: () => Promise<T>,
    ttlSeconds: number,
  ): Promise<T> {
    const key = await this.buildKey(namespace, keyParts);

    try {
      const hit = await this.redis.get(key);
      if (hit) return JSON.parse(hit) as T;
    } catch (error) {
      // A cache outage must degrade to a slow response, never to an error.
      this.logger.warn(`cache read failed for ${key}: ${String(error)}`);
      return factory();
    }

    const value = await factory();

    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (error) {
      this.logger.warn(`cache write failed for ${key}: ${String(error)}`);
    }

    return value;
  }

  /**
   * O(1) invalidation. Every key in the namespace embeds the generation, so
   * incrementing it orphans all of them without scanning or tracking keys.
   */
  async bumpGeneration(namespace: string): Promise<void> {
    await this.redis.incr(this.generationKey(namespace));
  }

  async del(namespace: string, keyParts: unknown): Promise<void> {
    await this.redis.del(await this.buildKey(namespace, keyParts));
  }

  private async buildKey(namespace: string, keyParts: unknown): Promise<string> {
    const generation = (await this.redis.get(this.generationKey(namespace))) ?? '0';
    const digest = createHash('sha1')
      .update(stableStringify(keyParts))
      .digest('hex')
      .slice(0, 16);
    return `cache:${namespace}:g${generation}:${digest}`;
  }

  private generationKey(namespace: string): string {
    return `cache:gen:${namespace}`;
  }
}

/** Property order must not change the cache key. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);

  return `{${entries.join(',')}}`;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx jest src/core/cache`
Expected: PASS, 7 tests.

- [ ] **Step 6: Write `src/core/cache/redis.module.ts`**

```ts
import { Global, Module, OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';

import { SettingsService } from '../settings/settings.service';
import { CacheService, REDIS } from './cache.service';

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [SettingsService],
      useFactory: async (settings: SettingsService): Promise<Redis> => {
        const url = await settings.get<string>('redis.url');
        return new Redis(url, { maxRetriesPerRequest: null });
      },
    },
    CacheService,
  ],
  exports: [CacheService, REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}
```

Add the missing `Inject` to the `@nestjs/common` import line.

- [ ] **Step 7: Add the `redis.url` setting**

Append to `SETTING_DEFINITIONS` in `src/core/settings/setting-definitions.ts`:

```ts
  defineSetting({
    key: 'redis.url',
    group: 'infrastructure',
    type: 'string',
    default: 'redis://localhost:6379',
    secret: true,
    description: 'Connection URL for Redis (cache, queue, rate limiting).',
  }),
```

Note this is `secret: true` — a Redis URL normally carries a password.

- [ ] **Step 8: Register `RedisModule` in `src/app.module.ts`** (after `SettingsModule`, which it depends on).

- [ ] **Step 9: Verify the gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all exit 0.

- [ ] **Step 10: Commit**

```bash
git add src/core/cache src/core/settings/setting-definitions.ts src/app.module.ts package.json package-lock.json
git commit -m "feat: add Redis cache with generation-counter invalidation

Every key embeds a per-namespace generation, so a publish bumps one integer
and orphans the whole namespace in O(1) with no key scanning. Cache failures
degrade to a slow response rather than an error.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 10: BullMQ queue module

**Files:**
- Create: `src/core/queue/queue.module.ts`
- Create: `src/core/queue/queue.constants.ts`
- Create: `src/core/queue/queue.service.ts`
- Create: `src/core/queue/queue.service.spec.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `REDIS` token (Task 9), `SettingsService`
- Produces:
  - `QUEUE_ASSET_PROCESSING = 'asset-processing'`
  - `interface AssetProcessingJob { assetId: string; processor: string }`
  - `QueueService.enqueueAssetProcessing(job: AssetProcessingJob): Promise<string>` — returns the job id
  - `QueueService.getQueueHealth(): Promise<{ waiting: number; active: number; failed: number }>`

- [ ] **Step 1: Install BullMQ**

```bash
npm i bullmq@^5 @nestjs/bullmq@^11
```

- [ ] **Step 2: Write `src/core/queue/queue.constants.ts`**

```ts
export const QUEUE_ASSET_PROCESSING = 'asset-processing';

export interface AssetProcessingJob {
  assetId: string;
  processor: string;
}
```

- [ ] **Step 3: Write the failing test**

Create `src/core/queue/queue.service.spec.ts`:

```ts
import { QueueService } from './queue.service';

function fakeQueue() {
  return {
    add: jest.fn(async () => ({ id: 'job-1' })),
    getWaitingCount: jest.fn(async () => 2),
    getActiveCount: jest.fn(async () => 1),
    getFailedCount: jest.fn(async () => 0),
  };
}

describe('QueueService', () => {
  it('enqueues a processing job named after the processor', async () => {
    const queue = fakeQueue();
    const svc = new QueueService(queue as never);

    await svc.enqueueAssetProcessing({ assetId: 'a1', processor: 'audio:preview' });

    expect(queue.add).toHaveBeenCalledWith(
      'audio:preview',
      { assetId: 'a1', processor: 'audio:preview' },
      expect.objectContaining({ attempts: expect.any(Number) }),
    );
  });

  it('returns the job id', async () => {
    const svc = new QueueService(fakeQueue() as never);
    await expect(
      svc.enqueueAssetProcessing({ assetId: 'a1', processor: 'audio:preview' }),
    ).resolves.toBe('job-1');
  });

  it('retries with backoff so a transient provider failure is not fatal', async () => {
    const queue = fakeQueue();
    const svc = new QueueService(queue as never);
    await svc.enqueueAssetProcessing({ assetId: 'a1', processor: 'audio:preview' });

    const opts = queue.add.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.attempts).toBeGreaterThan(1);
    expect(opts.backoff).toMatchObject({ type: 'exponential' });
  });

  it('reports queue health for the admin jobs endpoint', async () => {
    const svc = new QueueService(fakeQueue() as never);
    await expect(svc.getQueueHealth()).resolves.toEqual({
      waiting: 2,
      active: 1,
      failed: 0,
    });
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `npx jest src/core/queue`
Expected: FAIL — `Cannot find module './queue.service'`.

- [ ] **Step 5: Write `src/core/queue/queue.service.ts`**

```ts
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';

import { AssetProcessingJob, QUEUE_ASSET_PROCESSING } from './queue.constants';

@Injectable()
export class QueueService {
  constructor(
    @InjectQueue(QUEUE_ASSET_PROCESSING) private readonly queue: Queue,
  ) {}

  async enqueueAssetProcessing(job: AssetProcessingJob): Promise<string> {
    const added = await this.queue.add(job.processor, job, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 86_400, count: 1_000 },
      removeOnFail: false, // failures stay visible in the admin jobs endpoint
    });
    return String(added.id);
  }

  async getQueueHealth(): Promise<{
    waiting: number;
    active: number;
    failed: number;
  }> {
    const [waiting, active, failed] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getFailedCount(),
    ]);
    return { waiting, active, failed };
  }
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx jest src/core/queue`
Expected: PASS, 4 tests.

- [ ] **Step 7: Write `src/core/queue/queue.module.ts`**

```ts
import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';

import { SettingsService } from '../settings/settings.service';
import { QUEUE_ASSET_PROCESSING } from './queue.constants';
import { QueueService } from './queue.service';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [SettingsService],
      useFactory: async (settings: SettingsService) => ({
        connection: { url: await settings.get<string>('redis.url') },
      }),
    }),
    BullModule.registerQueue({ name: QUEUE_ASSET_PROCESSING }),
  ],
  providers: [QueueService],
  exports: [QueueService, BullModule],
})
export class QueueModule {}
```

Register `QueueModule` in `src/app.module.ts`.

- [ ] **Step 8: Verify the gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/core/queue src/app.module.ts package.json package-lock.json
git commit -m "feat: add BullMQ queue for asset processing

Failed jobs are retained so the admin jobs endpoint can surface a font that
failed to parse, rather than leaving the asset stuck in processing with
nobody looking.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 11: Audit log and health endpoints

**Files:**
- Create: `src/core/audit/audit.service.ts`
- Create: `src/core/audit/audit.service.spec.ts`
- Create: `src/core/audit/audit.module.ts`
- Create: `src/core/health/health.controller.ts`
- Create: `src/core/health/health.controller.spec.ts`
- Create: `src/core/health/health.module.ts`
- Modify: `prisma/schema.prisma`, `src/app.module.ts`

**Interfaces:**
- Consumes: `PrismaService`, `REDIS` (Task 9), `StorageRegistry` (Task 8)
- Produces:
  - `interface AuditEntry { actorId?: string; actorType: 'admin' | 'system'; action: string; entityType: string; entityId?: string; before?: unknown; after?: unknown; ip?: string; userAgent?: string }`
  - `AuditService.record(entry: AuditEntry): Promise<void>`
  - `GET /health` → `{ status: 'ok' }`
  - `GET /health/ready` → 200 when DB, Redis and default storage all respond; 503 otherwise

- [ ] **Step 1: Add the `AuditLog` model to `prisma/schema.prisma`**

```prisma
model AuditLog {
  id         String   @id @default(cuid())
  actorId    String?
  actorType  String
  action     String
  entityType String
  entityId   String?
  before     Json?
  after      Json?
  ip         String?
  userAgent  String?
  createdAt  DateTime @default(now())

  @@index([entityType, entityId])
  @@index([actorId, createdAt(sort: Desc)])
  @@index([createdAt(sort: Desc)])
}
```

- [ ] **Step 2: Migrate and regenerate**

```bash
npx prisma migrate dev --name add_audit_log
npx prisma generate
```

- [ ] **Step 3: Write the failing audit test**

Create `src/core/audit/audit.service.spec.ts`:

```ts
import { AuditService } from './audit.service';

function prismaMock() {
  return { auditLog: { create: jest.fn(async ({ data }: { data: unknown }) => data) } };
}

describe('AuditService', () => {
  it('writes the entry', async () => {
    const prisma = prismaMock();
    const svc = new AuditService(prisma as never);

    await svc.record({
      actorId: 'admin-1',
      actorType: 'admin',
      action: 'asset.publish',
      entityType: 'Asset',
      entityId: 'a1',
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'asset.publish', entityId: 'a1' }),
    });
  });

  it('redacts secret-looking fields from the before/after payload', async () => {
    const prisma = prismaMock();
    const svc = new AuditService(prisma as never);

    await svc.record({
      actorType: 'admin',
      action: 'settings.update',
      entityType: 'SystemSetting',
      after: { key: 'auth.jwtAccessSecret', apiSecret: 'hunter2', password: 'p' },
    });

    const written = prisma.auditLog.create.mock.calls[0][0].data as {
      after: Record<string, unknown>;
    };
    expect(written.after.apiSecret).toBe('[redacted]');
    expect(written.after.password).toBe('[redacted]');
    expect(JSON.stringify(written)).not.toContain('hunter2');
  });

  it('never throws, so a failed audit write cannot fail the request', async () => {
    const prisma = prismaMock();
    prisma.auditLog.create.mockRejectedValue(new Error('db down'));
    const svc = new AuditService(prisma as never);

    await expect(
      svc.record({ actorType: 'system', action: 'x', entityType: 'y' }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `npx jest src/core/audit`
Expected: FAIL — cannot find module.

- [ ] **Step 5: Write `src/core/audit/audit.service.ts`**

```ts
import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

export interface AuditEntry {
  actorId?: string;
  actorType: 'admin' | 'system';
  action: string;
  entityType: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
  userAgent?: string;
}

const SECRET_FIELD = /secret|password|token|apikey|api_key|credential/i;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorId: entry.actorId ?? null,
          actorType: entry.actorType,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId ?? null,
          before: redact(entry.before) as never,
          after: redact(entry.after) as never,
          ip: entry.ip ?? null,
          userAgent: entry.userAgent ?? null,
        },
      });
    } catch (error) {
      // An audit failure must never take down the operation being audited.
      this.logger.error(`audit write failed for ${entry.action}: ${String(error)}`);
    }
  }
}

function redact(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      SECRET_FIELD.test(k) ? '[redacted]' : redact(v),
    ]),
  );
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx jest src/core/audit`
Expected: PASS, 3 tests.

- [ ] **Step 7: Write `src/core/audit/audit.module.ts`**

```ts
import { Global, Module } from '@nestjs/common';

import { AuditService } from './audit.service';

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
```

- [ ] **Step 8: Write the failing health test**

Create `src/core/health/health.controller.spec.ts`:

```ts
import { ServiceUnavailableException } from '@nestjs/common';

import { HealthController } from './health.controller';

function deps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    prisma: { $queryRaw: jest.fn(async () => [{ ok: 1 }]) },
    redis: { ping: jest.fn(async () => 'PONG') },
    storage: { getDefault: jest.fn(async () => ({ id: 'prov-1' })) },
    ...overrides,
  };
}

describe('HealthController', () => {
  it('liveness returns ok without touching any dependency', () => {
    const d = deps();
    const c = new HealthController(d.prisma as never, d.redis as never, d.storage as never);
    expect(c.live()).toEqual({ status: 'ok' });
    expect(d.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('readiness reports every dependency up', async () => {
    const d = deps();
    const c = new HealthController(d.prisma as never, d.redis as never, d.storage as never);
    await expect(c.ready()).resolves.toEqual({
      status: 'ok',
      checks: { database: 'up', redis: 'up', storage: 'up' },
    });
  });

  it('readiness throws 503 when the database is down', async () => {
    const d = deps({ prisma: { $queryRaw: jest.fn().mockRejectedValue(new Error('x')) } });
    const c = new HealthController(d.prisma as never, d.redis as never, d.storage as never);
    await expect(c.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('readiness names which dependency failed', async () => {
    const d = deps({ redis: { ping: jest.fn().mockRejectedValue(new Error('x')) } });
    const c = new HealthController(d.prisma as never, d.redis as never, d.storage as never);
    await expect(c.ready()).rejects.toMatchObject({
      response: { checks: { redis: 'down', database: 'up' } },
    });
  });
});
```

- [ ] **Step 9: Run to verify it fails**

Run: `npx jest src/core/health`
Expected: FAIL — cannot find module.

- [ ] **Step 10: Write `src/core/health/health.controller.ts`**

```ts
import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import type Redis from 'ioredis';

import { PrismaService } from '../../prisma/prisma.service';
import { REDIS } from '../cache/cache.service';
import { StorageRegistry } from '../storage/storage.registry';

type CheckState = 'up' | 'down';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly storage: StorageRegistry,
  ) {}

  /** Liveness: is the process running? Must not touch dependencies. */
  @Get()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: can this instance actually serve traffic? */
  @Get('ready')
  async ready(): Promise<{ status: 'ok'; checks: Record<string, CheckState> }> {
    const checks: Record<string, CheckState> = {
      database: await probe(() => this.prisma.$queryRaw`SELECT 1`),
      redis: await probe(() => this.redis.ping()),
      storage: await probe(() => this.storage.getDefault()),
    };

    if (Object.values(checks).some((state) => state === 'down')) {
      throw new ServiceUnavailableException({ status: 'error', checks });
    }

    return { status: 'ok', checks };
  }
}

async function probe(fn: () => Promise<unknown>): Promise<CheckState> {
  try {
    await fn();
    return 'up';
  } catch {
    return 'down';
  }
}
```

- [ ] **Step 11: Run to verify it passes**

Run: `npx jest src/core/health`
Expected: PASS, 4 tests.

- [ ] **Step 12: Write `src/core/health/health.module.ts`**

```ts
import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';

@Module({ controllers: [HealthController] })
export class HealthModule {}
```

Register `AuditModule` and `HealthModule` in `src/app.module.ts`.

- [ ] **Step 13: Verify the gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all exit 0.

- [ ] **Step 14: Commit**

```bash
git add src/core/audit src/core/health src/app.module.ts prisma/
git commit -m "feat: add audit log and liveness/readiness endpoints

Audit writes redact secret-looking fields and never throw, so an audit
failure cannot fail the operation it records. Readiness probes DB, Redis and
the default storage provider and names which one is down.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

**Phase 1 exit condition:** `npm run typecheck && npm run lint && npm test` pass. With Redis running and a seeded `StorageProvider` row, `GET /health/ready` returns 200.

---

# Phase 2 — Admin authentication

This is the phase that makes the server safe to deploy. Until it lands, `POST /api/v1/audio/upload/sign` hands Cloudinary credentials to any anonymous caller.

## Task 12: Password hashing and the admin schema

**Files:**
- Create: `src/modules/auth/password.service.ts`
- Create: `src/modules/auth/password.service.spec.ts`
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `PasswordService.hash(plain: string): Promise<string>`
  - `PasswordService.verify(hash: string, plain: string): Promise<boolean>`

- [ ] **Step 1: Install argon2**

```bash
npm i argon2@^0.41
```

argon2id is the current password-hashing recommendation; bcrypt's 72-byte input truncation makes it the weaker choice here.

- [ ] **Step 2: Add auth models to `prisma/schema.prisma`**

```prisma
enum AdminRole {
  owner
  admin
  editor
  viewer
}

model AdminUser {
  id           String         @id @default(cuid())
  email        String         @unique
  passwordHash String
  name         String
  role         AdminRole      @default(editor)
  isActive     Boolean        @default(true)
  lastLoginAt  DateTime?
  createdAt    DateTime       @default(now())
  updatedAt    DateTime       @updatedAt
  deletedAt    DateTime?
  tokens       RefreshToken[]
}

model RefreshToken {
  id          String    @id @default(cuid())
  tokenHash   String    @unique
  familyId    String
  adminUserId String
  expiresAt   DateTime
  revokedAt   DateTime?
  userAgent   String?
  ip          String?
  createdAt   DateTime  @default(now())

  admin AdminUser @relation(fields: [adminUserId], references: [id], onDelete: Cascade)

  @@index([adminUserId, revokedAt])
  @@index([familyId])
}
```

- [ ] **Step 3: Migrate and regenerate**

```bash
npx prisma migrate dev --name add_admin_auth
npx prisma generate
```

- [ ] **Step 4: Write the failing test**

Create `src/modules/auth/password.service.spec.ts`:

```ts
import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const svc = new PasswordService();

  it('verifies a correct password', async () => {
    const hash = await svc.hash('correct-horse-battery');
    await expect(svc.verify(hash, 'correct-horse-battery')).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await svc.hash('correct-horse-battery');
    await expect(svc.verify(hash, 'wrong')).resolves.toBe(false);
  });

  it('never stores the plaintext in the hash', async () => {
    const hash = await svc.hash('correct-horse-battery');
    expect(hash).not.toContain('correct-horse-battery');
  });

  it('produces a different hash for the same password each time', async () => {
    const a = await svc.hash('same');
    const b = await svc.hash('same');
    expect(a).not.toBe(b);
    await expect(svc.verify(a, 'same')).resolves.toBe(true);
    await expect(svc.verify(b, 'same')).resolves.toBe(true);
  });

  it('uses argon2id', async () => {
    expect(await svc.hash('x')).toMatch(/^\$argon2id\$/);
  });

  it('returns false rather than throwing on a malformed hash', async () => {
    await expect(svc.verify('not-a-hash', 'x')).resolves.toBe(false);
  });
});
```

- [ ] **Step 5: Run to verify it fails**

Run: `npx jest src/modules/auth/password.service.spec.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 6: Write `src/modules/auth/password.service.ts`**

```ts
import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

@Injectable()
export class PasswordService {
  async hash(plain: string): Promise<string> {
    return argon2.hash(plain, { type: argon2.argon2id });
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      // A malformed stored hash must read as "wrong password", not a 500.
      return false;
    }
  }
}
```

- [ ] **Step 7: Run to verify it passes**

Run: `npx jest src/modules/auth/password.service.spec.ts`
Expected: PASS, 6 tests.

- [ ] **Step 8: Commit**

```bash
git add src/modules/auth prisma/ package.json package-lock.json
git commit -m "feat: add argon2id password hashing and admin auth schema

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 13: Token service with refresh rotation and reuse detection

The security property this task delivers: presenting an already-revoked refresh token revokes the entire token family. That is the standard defence against a stolen refresh token, because the thief's use of the old token invalidates the victim's session and the theft becomes visible.

**Files:**
- Create: `src/modules/auth/token.service.ts`
- Create: `src/modules/auth/token.service.spec.ts`

**Interfaces:**
- Consumes: `SettingsService` (Task 7), `PrismaService`, `@nestjs/jwt`
- Produces:
  - `interface TokenPair { accessToken: string; refreshToken: string; expiresIn: number }`
  - `interface AccessTokenClaims { sub: string; email: string; role: AdminRole }`
  - `TokenService.issuePair(admin, context): Promise<TokenPair>`
  - `TokenService.rotate(presentedRefreshToken, context): Promise<TokenPair>`
  - `TokenService.revokeFamily(familyId: string): Promise<void>`
  - `TokenService.verifyAccessToken(token: string): Promise<AccessTokenClaims>`

- [ ] **Step 1: Install JWT**

```bash
npm i @nestjs/jwt@^11
```

- [ ] **Step 2: Write the failing test**

Create `src/modules/auth/token.service.spec.ts`:

```ts
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';

import { TokenService } from './token.service';

const ADMIN = {
  id: 'admin-1',
  email: 'a@example.com',
  role: 'admin' as const,
};

function settingsMock() {
  const values: Record<string, unknown> = {
    'auth.accessTokenTtlSeconds': 900,
    'auth.refreshTokenTtlSeconds': 604_800,
    'auth.jwtAccessSecret': 'test-signing-secret-that-is-long-enough',
  };
  return { get: jest.fn(async (k: string) => values[k]) };
}

function prismaMock() {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    refreshToken: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        rows.push(data);
        return data;
      }),
      findUnique: jest.fn(async ({ where }: { where: { tokenHash: string } }) =>
        rows.find((r) => r.tokenHash === where.tokenHash) ?? null,
      ),
      update: jest.fn(async ({ where, data }: { where: { tokenHash: string }; data: Record<string, unknown> }) => {
        const row = rows.find((r) => r.tokenHash === where.tokenHash);
        if (row) Object.assign(row, data);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: { familyId: string }; data: Record<string, unknown> }) => {
        let count = 0;
        for (const r of rows) {
          if (r.familyId === where.familyId && !r.revokedAt) {
            Object.assign(r, data);
            count += 1;
          }
        }
        return { count };
      }),
    },
  };
}

function build() {
  const prisma = prismaMock();
  const settings = settingsMock();
  const svc = new TokenService(prisma as never, settings as never, new JwtService({}));
  return { svc, prisma, settings };
}

const CTX = { ip: '1.2.3.4', userAgent: 'jest' };

describe('TokenService', () => {
  it('issues an access token carrying the admin id, email and role', async () => {
    const { svc } = build();
    const pair = await svc.issuePair(ADMIN, CTX);
    const claims = await svc.verifyAccessToken(pair.accessToken);

    expect(claims.sub).toBe('admin-1');
    expect(claims.email).toBe('a@example.com');
    expect(claims.role).toBe('admin');
  });

  it('stores only a hash of the refresh token, never the token itself', async () => {
    const { svc, prisma } = build();
    const pair = await svc.issuePair(ADMIN, CTX);

    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0].tokenHash).not.toBe(pair.refreshToken);
    expect(JSON.stringify(prisma.rows[0])).not.toContain(pair.refreshToken);
  });

  it('rotation issues a new pair and revokes the presented token', async () => {
    const { svc, prisma } = build();
    const first = await svc.issuePair(ADMIN, CTX);
    const second = await svc.rotate(first.refreshToken, CTX);

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(prisma.rows[0].revokedAt).toBeTruthy();
  });

  it('keeps the rotated token in the same family', async () => {
    const { svc, prisma } = build();
    const first = await svc.issuePair(ADMIN, CTX);
    await svc.rotate(first.refreshToken, CTX);

    expect(prisma.rows[1].familyId).toBe(prisma.rows[0].familyId);
  });

  it('reusing a revoked refresh token revokes the whole family', async () => {
    const { svc, prisma } = build();
    const first = await svc.issuePair(ADMIN, CTX);
    await svc.rotate(first.refreshToken, CTX);

    await expect(svc.rotate(first.refreshToken, CTX)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(prisma.rows.every((r) => r.revokedAt)).toBe(true);
  });

  it('rejects an unknown refresh token', async () => {
    const { svc } = build();
    await expect(svc.rotate('never-issued', CTX)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects an expired refresh token', async () => {
    const { svc, prisma } = build();
    const pair = await svc.issuePair(ADMIN, CTX);
    prisma.rows[0].expiresAt = new Date(Date.now() - 1000);

    await expect(svc.rotate(pair.refreshToken, CTX)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a tampered access token', async () => {
    const { svc } = build();
    const pair = await svc.issuePair(ADMIN, CTX);
    await expect(svc.verifyAccessToken(`${pair.accessToken}x`)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('reports the access token ttl so clients can schedule refresh', async () => {
    const { svc } = build();
    await expect(svc.issuePair(ADMIN, CTX)).resolves.toMatchObject({ expiresIn: 900 });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx jest src/modules/auth/token.service.spec.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 4: Write `src/modules/auth/token.service.ts`**

```ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { AdminRole } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { SettingsService } from '../../core/settings/settings.service';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AccessTokenClaims {
  sub: string;
  email: string;
  role: AdminRole;
}

export interface TokenContext {
  ip?: string;
  userAgent?: string;
}

interface AdminLike {
  id: string;
  email: string;
  role: AdminRole;
}

@Injectable()
export class TokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly jwt: JwtService,
  ) {}

  async issuePair(
    admin: AdminLike,
    context: TokenContext,
    familyId = randomUUID(),
  ): Promise<TokenPair> {
    const accessTtl = await this.settings.get<number>('auth.accessTokenTtlSeconds');
    const refreshTtl = await this.settings.get<number>('auth.refreshTokenTtlSeconds');
    const secret = await this.signingSecret();

    const accessToken = await this.jwt.signAsync(
      { sub: admin.id, email: admin.email, role: admin.role },
      { secret, expiresIn: accessTtl },
    );

    const refreshToken = randomBytes(48).toString('base64url');

    await this.prisma.refreshToken.create({
      data: {
        tokenHash: hashToken(refreshToken),
        familyId,
        adminUserId: admin.id,
        expiresAt: new Date(Date.now() + refreshTtl * 1000),
        ip: context.ip ?? null,
        userAgent: context.userAgent ?? null,
      },
    });

    return { accessToken, refreshToken, expiresIn: accessTtl };
  }

  async rotate(presented: string, context: TokenContext): Promise<TokenPair> {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(presented) },
      include: { admin: true },
    });

    if (!row) throw new UnauthorizedException('Invalid refresh token.');

    // Reuse of an already-revoked token means the token was stolen. Kill the
    // whole lineage so neither party keeps a working session.
    if (row.revokedAt) {
      await this.revokeFamily(row.familyId);
      throw new UnauthorizedException('Refresh token reuse detected.');
    }

    if (row.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Refresh token expired.');
    }

    await this.prisma.refreshToken.update({
      where: { tokenHash: row.tokenHash },
      data: { revokedAt: new Date() },
    });

    const admin = (row as { admin?: AdminLike }).admin ?? {
      id: row.adminUserId,
      email: '',
      role: AdminRole.editor,
    };

    return this.issuePair(admin, context, row.familyId);
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    try {
      return await this.jwt.verifyAsync<AccessTokenClaims>(token, {
        secret: await this.signingSecret(),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired access token.');
    }
  }

  private async signingSecret(): Promise<string> {
    const secret = await this.settings.get<string>('auth.jwtAccessSecret');
    if (!secret) {
      throw new Error(
        'auth.jwtAccessSecret is empty. It is generated on first boot by the ' +
          'admin bootstrap; see Task 14.',
      );
    }
    return secret;
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx jest src/modules/auth/token.service.spec.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add src/modules/auth package.json package-lock.json
git commit -m "feat: add JWT token service with refresh rotation and reuse detection

Refresh tokens are stored only as sha256 hashes. Presenting an already-revoked
token revokes the entire family, so a stolen refresh token cannot be used
silently alongside the victim's session.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 14: Auth service — login, lockout, and first-owner bootstrap

**Files:**
- Create: `src/modules/auth/auth.service.ts`
- Create: `src/modules/auth/auth.service.spec.ts`
- Create: `src/modules/auth/dto/login.dto.ts`
- Create: `src/modules/auth/dto/refresh.dto.ts`

**Interfaces:**
- Consumes: `PasswordService` (Task 12), `TokenService` (Task 13), `SettingsService`, `AuditService`, `PrismaService`, `REDIS`
- Produces:
  - `AuthService.login(dto: LoginDto, ctx: TokenContext): Promise<TokenPair>`
  - `AuthService.refresh(dto: RefreshDto, ctx: TokenContext): Promise<TokenPair>`
  - `AuthService.logout(refreshToken: string): Promise<void>`
  - `AuthService.me(adminId: string): Promise<AdminProfile>`
  - `AuthService.bootstrap(): Promise<void>` — called by `onModuleInit`
  - `interface AdminProfile { id: string; email: string; name: string; role: AdminRole }`

- [ ] **Step 1: Write the DTOs**

Create `src/modules/auth/dto/login.dto.ts`:

```ts
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}
```

Create `src/modules/auth/dto/refresh.dto.ts`:

```ts
import { IsString } from 'class-validator';

export class RefreshDto {
  @IsString()
  refreshToken!: string;
}
```

- [ ] **Step 2: Add the bootstrap settings**

Append to `SETTING_DEFINITIONS` in `src/core/settings/setting-definitions.ts`:

```ts
  defineSetting({
    key: 'auth.bootstrapCompleted',
    group: 'auth',
    type: 'boolean',
    default: false,
    secret: false,
    description: 'Set once the first owner account exists. Disables bootstrap.',
  }),
```

- [ ] **Step 3: Write the failing test**

Create `src/modules/auth/auth.service.spec.ts`:

```ts
import { UnauthorizedException } from '@nestjs/common';

import { AuthService } from './auth.service';
import { PasswordService } from './password.service';

const CTX = { ip: '1.2.3.4', userAgent: 'jest' };

function build(opts: { admin?: Record<string, unknown> | null; attempts?: number } = {}) {
  const passwords = new PasswordService();

  const prisma = {
    adminUser: {
      findFirst: jest.fn(async () => opts.admin ?? null),
      count: jest.fn(async () => (opts.admin ? 1 : 0)),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'new-admin',
        ...data,
      })),
      update: jest.fn(async () => ({})),
    },
    refreshToken: { updateMany: jest.fn(async () => ({ count: 1 })) },
  };

  const settingsValues: Record<string, unknown> = {
    'auth.loginMaxAttempts': 5,
    'auth.loginLockoutSeconds': 900,
    'auth.bootstrapCompleted': false,
    'auth.jwtAccessSecret': 'seeded-secret-value-long-enough',
  };

  const settings = {
    get: jest.fn(async (k: string) => settingsValues[k]),
    set: jest.fn(async (k: string, v: unknown) => {
      settingsValues[k] = v;
    }),
  };

  let counter = opts.attempts ?? 0;
  const redis = {
    incr: jest.fn(async () => (counter += 1)),
    expire: jest.fn(async () => 1),
    get: jest.fn(async () => String(counter)),
    del: jest.fn(async () => {
      counter = 0;
      return 1;
    }),
  };

  const tokens = {
    issuePair: jest.fn(async () => ({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresIn: 900,
    })),
    rotate: jest.fn(async () => ({
      accessToken: 'at2',
      refreshToken: 'rt2',
      expiresIn: 900,
    })),
    revokeFamily: jest.fn(async () => undefined),
  };

  const audit = { record: jest.fn(async () => undefined) };

  const svc = new AuthService(
    prisma as never,
    passwords,
    tokens as never,
    settings as never,
    audit as never,
    redis as never,
  );

  return { svc, prisma, settings, redis, tokens, audit, passwords };
}

describe('AuthService.login', () => {
  it('returns a token pair for correct credentials', async () => {
    const passwords = new PasswordService();
    const admin = {
      id: 'admin-1',
      email: 'a@example.com',
      name: 'A',
      role: 'admin',
      isActive: true,
      deletedAt: null,
      passwordHash: await passwords.hash('correct-password'),
    };

    const { svc } = build({ admin });
    await expect(
      svc.login({ email: 'a@example.com', password: 'correct-password' }, CTX),
    ).resolves.toMatchObject({ accessToken: 'at' });
  });

  it('rejects a wrong password', async () => {
    const passwords = new PasswordService();
    const admin = {
      id: 'admin-1',
      email: 'a@example.com',
      name: 'A',
      role: 'admin',
      isActive: true,
      deletedAt: null,
      passwordHash: await passwords.hash('correct-password'),
    };

    const { svc } = build({ admin });
    await expect(
      svc.login({ email: 'a@example.com', password: 'wrong' }, CTX),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('gives the same error for unknown email as for wrong password', async () => {
    const { svc } = build({ admin: null });
    await expect(
      svc.login({ email: 'nobody@example.com', password: 'whatever12' }, CTX),
    ).rejects.toThrow('Invalid email or password.');
  });

  it('refuses a deactivated account', async () => {
    const passwords = new PasswordService();
    const admin = {
      id: 'admin-1',
      email: 'a@example.com',
      name: 'A',
      role: 'admin',
      isActive: false,
      deletedAt: null,
      passwordHash: await passwords.hash('correct-password'),
    };

    const { svc } = build({ admin });
    await expect(
      svc.login({ email: 'a@example.com', password: 'correct-password' }, CTX),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('locks out after the configured number of failures', async () => {
    const { svc } = build({ admin: null, attempts: 5 });
    await expect(
      svc.login({ email: 'a@example.com', password: 'whatever12' }, CTX),
    ).rejects.toThrow(/too many/i);
  });

  it('clears the failure counter after a successful login', async () => {
    const passwords = new PasswordService();
    const admin = {
      id: 'admin-1',
      email: 'a@example.com',
      name: 'A',
      role: 'admin',
      isActive: true,
      deletedAt: null,
      passwordHash: await passwords.hash('correct-password'),
    };

    const { svc, redis } = build({ admin });
    await svc.login({ email: 'a@example.com', password: 'correct-password' }, CTX);
    expect(redis.del).toHaveBeenCalled();
  });

  it('audits a failed login attempt', async () => {
    const { svc, audit } = build({ admin: null });
    await svc
      .login({ email: 'a@example.com', password: 'whatever12' }, CTX)
      .catch(() => undefined);

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.login.failed' }),
    );
  });

  it('never puts the password in the audit record', async () => {
    const { svc, audit } = build({ admin: null });
    await svc
      .login({ email: 'a@example.com', password: 'hunter2xyz' }, CTX)
      .catch(() => undefined);

    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('hunter2xyz');
  });
});

describe('AuthService.bootstrap', () => {
  it('creates the first owner when no admin exists', async () => {
    process.env.ADMIN_BOOTSTRAP_EMAIL = 'owner@example.com';
    process.env.ADMIN_BOOTSTRAP_PASSWORD = 'bootstrap-password-1';

    const { svc, prisma, settings } = build({ admin: null });
    await svc.bootstrap();

    expect(prisma.adminUser.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: 'owner@example.com', role: 'owner' }),
      }),
    );
    expect(settings.set).toHaveBeenCalledWith(
      'auth.bootstrapCompleted',
      true,
      'system',
    );

    delete process.env.ADMIN_BOOTSTRAP_EMAIL;
    delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
  });

  it('generates a jwt signing secret on first boot when none is set', async () => {
    const { svc, settings } = build({ admin: null });
    (settings.get as jest.Mock).mockImplementation(async (k: string) =>
      k === 'auth.jwtAccessSecret' ? '' : false,
    );

    await svc.bootstrap();

    const call = settings.set.mock.calls.find(
      ([k]: [string]) => k === 'auth.jwtAccessSecret',
    );
    expect(call).toBeDefined();
    expect(String(call![1]).length).toBeGreaterThanOrEqual(32);
  });

  it('does nothing when an admin already exists', async () => {
    const { svc, prisma } = build({ admin: { id: 'x' } });
    await svc.bootstrap();
    expect(prisma.adminUser.create).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `npx jest src/modules/auth/auth.service.spec.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 5: Write `src/modules/auth/auth.service.ts`**

```ts
import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import type Redis from 'ioredis';
import { randomBytes } from 'node:crypto';

import { AdminRole } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { REDIS } from '../../core/cache/cache.service';
import { SettingsService } from '../../core/settings/settings.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { PasswordService } from './password.service';
import { TokenContext, TokenPair, TokenService } from './token.service';

export interface AdminProfile {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.bootstrap();
  }

  async login(dto: LoginDto, ctx: TokenContext): Promise<TokenPair> {
    await this.assertNotLockedOut(dto.email);

    const admin = await this.prisma.adminUser.findFirst({
      where: { email: dto.email, deletedAt: null },
    });

    const ok =
      admin !== null &&
      admin.isActive &&
      (await this.passwords.verify(admin.passwordHash, dto.password));

    if (!ok) {
      await this.recordFailure(dto.email, ctx);
      // Identical message for unknown-email and wrong-password so the endpoint
      // cannot be used to enumerate which accounts exist.
      throw new UnauthorizedException('Invalid email or password.');
    }

    await this.redis.del(this.attemptKey(dto.email));
    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });

    await this.audit.record({
      actorId: admin.id,
      actorType: 'admin',
      action: 'auth.login.succeeded',
      entityType: 'AdminUser',
      entityId: admin.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return this.tokens.issuePair(
      { id: admin.id, email: admin.email, role: admin.role },
      ctx,
    );
  }

  async refresh(dto: RefreshDto, ctx: TokenContext): Promise<TokenPair> {
    return this.tokens.rotate(dto.refreshToken, ctx);
  }

  async logout(refreshToken: string): Promise<void> {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashFor(refreshToken) },
    });
    if (row) await this.tokens.revokeFamily(row.familyId);
  }

  async me(adminId: string): Promise<AdminProfile> {
    const admin = await this.prisma.adminUser.findFirst({
      where: { id: adminId, deletedAt: null },
    });
    if (!admin) throw new UnauthorizedException('Account no longer exists.');

    return {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      role: admin.role,
    };
  }

  /**
   * Runs once at boot. Generates the JWT signing secret if absent, and creates
   * the first owner from env if no admin exists. Self-disabling.
   */
  async bootstrap(): Promise<void> {
    const existingSecret = await this.settings.get<string>('auth.jwtAccessSecret');
    if (!existingSecret) {
      await this.settings.set(
        'auth.jwtAccessSecret',
        randomBytes(48).toString('base64url'),
        'system',
      );
      this.logger.log('Generated auth.jwtAccessSecret on first boot.');
    }

    const adminCount = await this.prisma.adminUser.count({
      where: { deletedAt: null },
    });
    if (adminCount > 0) return;

    const email = process.env.ADMIN_BOOTSTRAP_EMAIL;
    const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;

    if (!email || !password) {
      this.logger.warn(
        'No admin accounts exist. Set ADMIN_BOOTSTRAP_EMAIL and ' +
          'ADMIN_BOOTSTRAP_PASSWORD, then restart, to create the first owner.',
      );
      return;
    }

    await this.prisma.adminUser.create({
      data: {
        email: email.trim().toLowerCase(),
        name: 'Owner',
        role: AdminRole.owner,
        passwordHash: await this.passwords.hash(password),
      },
    });

    await this.settings.set('auth.bootstrapCompleted', true, 'system');
    this.logger.log(`Bootstrapped first owner account: ${email}`);
  }

  private attemptKey(email: string): string {
    return `auth:login:fail:${email.toLowerCase()}`;
  }

  private async assertNotLockedOut(email: string): Promise<void> {
    const max = await this.settings.get<number>('auth.loginMaxAttempts');
    const current = Number((await this.redis.get(this.attemptKey(email))) ?? '0');

    if (current >= max) {
      throw new UnauthorizedException(
        'Too many failed login attempts. Try again later.',
      );
    }
  }

  private async recordFailure(email: string, ctx: TokenContext): Promise<void> {
    const key = this.attemptKey(email);
    const lockout = await this.settings.get<number>('auth.loginLockoutSeconds');

    await this.redis.incr(key);
    await this.redis.expire(key, lockout);

    await this.audit.record({
      actorType: 'system',
      action: 'auth.login.failed',
      entityType: 'AdminUser',
      after: { email },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }
}

function hashFor(token: string): string {
  // Mirrors TokenService.hashToken — both hash the presented token before lookup.
  return require('node:crypto').createHash('sha256').update(token).digest('hex');
}
```

Replace the `require` in `hashFor` with a top-level `import { createHash } from 'node:crypto';` and call `createHash(...)` directly — the lint rule forbids `require` in TypeScript sources.

- [ ] **Step 6: Exempt the bootstrap env reads**

`ADMIN_BOOTSTRAP_EMAIL` and `ADMIN_BOOTSTRAP_PASSWORD` are a deliberate fourth and fifth env read, used exactly once at first boot. Add `src/modules/auth/auth.service.ts` to the `no-restricted-properties` exemption list in `eslint.config.mjs`, and document both in `.env.example`.

- [ ] **Step 7: Run to verify it passes**

Run: `npx jest src/modules/auth/auth.service.spec.ts`
Expected: PASS, 11 tests.

- [ ] **Step 8: Verify the gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/modules/auth src/core/settings/setting-definitions.ts eslint.config.mjs .env.example
git commit -m "feat: add admin login with lockout and first-owner bootstrap

Unknown email and wrong password return an identical error so the endpoint
cannot enumerate accounts. The JWT signing secret is generated into settings
on first boot rather than read from env.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 15: Guards, permissions, and the auth controller

**Files:**
- Create: `src/core/auth/permissions.ts`
- Create: `src/core/auth/permissions.spec.ts`
- Create: `src/core/auth/jwt-auth.guard.ts`
- Create: `src/core/auth/permissions.guard.ts`
- Create: `src/core/auth/permissions.guard.spec.ts`
- Create: `src/core/auth/current-user.decorator.ts`
- Create: `src/modules/auth/auth.controller.ts`
- Create: `src/modules/auth/auth.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `TokenService` (Task 13), `AuthService` (Task 14)
- Produces:
  - `type Permission` — string union of every permission constant
  - `ROLE_PERMISSIONS: Record<AdminRole, readonly Permission[]>`
  - `roleHas(role: AdminRole, permission: Permission): boolean`
  - `@RequirePermission(permission: Permission)` decorator
  - `JwtAuthGuard`, `PermissionsGuard`
  - `@CurrentUser()` param decorator yielding `AccessTokenClaims`
  - `POST /api/admin/v1/auth/login | refresh | logout`, `GET /api/admin/v1/auth/me`

- [ ] **Step 1: Write the failing permissions test**

Create `src/core/auth/permissions.spec.ts`:

```ts
import { AdminRole } from '../../generated/prisma/enums';
import { ROLE_PERMISSIONS, roleHas } from './permissions';

describe('permissions', () => {
  it('owner has every permission any other role has', () => {
    const others = [AdminRole.admin, AdminRole.editor, AdminRole.viewer];
    for (const role of others) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(ROLE_PERMISSIONS[AdminRole.owner]).toContain(permission);
      }
    }
  });

  it('only owner may write system settings', () => {
    expect(roleHas(AdminRole.owner, 'settings.write')).toBe(true);
    expect(roleHas(AdminRole.admin, 'settings.write')).toBe(false);
    expect(roleHas(AdminRole.editor, 'settings.write')).toBe(false);
  });

  it('editor may upload and edit but not delete', () => {
    expect(roleHas(AdminRole.editor, 'asset.create')).toBe(true);
    expect(roleHas(AdminRole.editor, 'asset.update')).toBe(true);
    expect(roleHas(AdminRole.editor, 'asset.delete')).toBe(false);
  });

  it('viewer may only read', () => {
    expect(roleHas(AdminRole.viewer, 'asset.read')).toBe(true);
    expect(roleHas(AdminRole.viewer, 'asset.create')).toBe(false);
    expect(roleHas(AdminRole.viewer, 'asset.publish')).toBe(false);
  });

  it('only owner may manage other admins', () => {
    expect(roleHas(AdminRole.owner, 'admin.manage')).toBe(true);
    expect(roleHas(AdminRole.admin, 'admin.manage')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/core/auth/permissions.spec.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write `src/core/auth/permissions.ts`**

```ts
import { SetMetadata } from '@nestjs/common';

import { AdminRole } from '../../generated/prisma/enums';

export const PERMISSIONS = [
  'asset.read',
  'asset.create',
  'asset.update',
  'asset.publish',
  'asset.delete',
  'taxonomy.read',
  'taxonomy.write',
  'settings.read',
  'settings.write',
  'storage.manage',
  'admin.manage',
  'audit.read',
  'jobs.read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const VIEWER: readonly Permission[] = [
  'asset.read',
  'taxonomy.read',
  'settings.read',
  'audit.read',
  'jobs.read',
];

const EDITOR: readonly Permission[] = [
  ...VIEWER,
  'asset.create',
  'asset.update',
  'asset.publish',
  'taxonomy.write',
];

const ADMIN: readonly Permission[] = [...EDITOR, 'asset.delete'];

const OWNER: readonly Permission[] = [
  ...ADMIN,
  'settings.write',
  'storage.manage',
  'admin.manage',
];

export const ROLE_PERMISSIONS: Record<AdminRole, readonly Permission[]> = {
  [AdminRole.owner]: OWNER,
  [AdminRole.admin]: ADMIN,
  [AdminRole.editor]: EDITOR,
  [AdminRole.viewer]: VIEWER,
};

export function roleHas(role: AdminRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export const PERMISSION_KEY = 'required_permission';

export const RequirePermission = (permission: Permission) =>
  SetMetadata(PERMISSION_KEY, permission);
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/core/auth/permissions.spec.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing guard test**

Create `src/core/auth/permissions.guard.spec.ts`:

```ts
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AdminRole } from '../../generated/prisma/enums';
import { PermissionsGuard } from './permissions.guard';

function ctxFor(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

describe('PermissionsGuard', () => {
  function guardRequiring(permission: string | undefined) {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(permission) };
    return new PermissionsGuard(reflector as unknown as Reflector);
  }

  it('allows a route with no declared permission', () => {
    expect(guardRequiring(undefined).canActivate(ctxFor({ role: AdminRole.viewer })))
      .toBe(true);
  });

  it('allows a role that holds the permission', () => {
    expect(
      guardRequiring('asset.publish').canActivate(ctxFor({ role: AdminRole.editor })),
    ).toBe(true);
  });

  it('rejects a role that lacks the permission', () => {
    expect(() =>
      guardRequiring('asset.delete').canActivate(ctxFor({ role: AdminRole.editor })),
    ).toThrow(ForbiddenException);
  });

  it('rejects when no user is attached to the request', () => {
    expect(() =>
      guardRequiring('asset.read').canActivate(ctxFor(undefined)),
    ).toThrow(ForbiddenException);
  });

  it('names the missing permission in the error', () => {
    expect(() =>
      guardRequiring('settings.write').canActivate(ctxFor({ role: AdminRole.admin })),
    ).toThrow(/settings\.write/);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx jest src/core/auth/permissions.guard.spec.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 7: Write the guards and decorator**

Create `src/core/auth/permissions.guard.ts`:

```ts
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AdminRole } from '../../generated/prisma/enums';
import { Permission, PERMISSION_KEY, roleHas } from './permissions';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission | undefined>(
      PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!required) return true;

    const user = context
      .switchToHttp()
      .getRequest<{ user?: { role: AdminRole } }>().user;

    if (!user) throw new ForbiddenException('Not authenticated.');

    if (!roleHas(user.role, required)) {
      throw new ForbiddenException(`Missing required permission: ${required}`);
    }

    return true;
  }
}
```

Create `src/core/auth/jwt-auth.guard.ts`:

```ts
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { TokenService } from '../../modules/auth/token.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly tokens: TokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: unknown }>();

    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');

    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException('Missing bearer token.');
    }

    req.user = await this.tokens.verifyAccessToken(token);
    return true;
  }
}
```

Create `src/core/auth/current-user.decorator.ts`:

```ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import { AccessTokenClaims } from '../../modules/auth/token.service';

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AccessTokenClaims =>
    context.switchToHttp().getRequest<{ user: AccessTokenClaims }>().user,
);
```

- [ ] **Step 8: Run to verify the guard test passes**

Run: `npx jest src/core/auth`
Expected: PASS, 10 tests.

- [ ] **Step 9: Write `src/modules/auth/auth.controller.ts`**

```ts
import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../../core/auth/current-user.decorator';
import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { AccessTokenClaims } from './token.service';

interface RequestLike {
  ip?: string;
  headers: Record<string, string | undefined>;
}

@Controller('api/admin/v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: RequestLike) {
    return { success: true as const, data: await this.auth.login(dto, ctx(req)) };
  }

  @Post('refresh')
  async refresh(@Body() dto: RefreshDto, @Req() req: RequestLike) {
    return { success: true as const, data: await this.auth.refresh(dto, ctx(req)) };
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  async logout(@Body() dto: RefreshDto) {
    await this.auth.logout(dto.refreshToken);
    return { success: true as const, data: { loggedOut: true } };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: AccessTokenClaims) {
    return { success: true as const, data: await this.auth.me(user.sub) };
  }
}

function ctx(req: RequestLike) {
  return { ip: req.ip, userAgent: req.headers['user-agent'] };
}
```

- [ ] **Step 10: Write `src/modules/auth/auth.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    JwtAuthGuard,
    PermissionsGuard,
  ],
  exports: [TokenService, JwtAuthGuard, PermissionsGuard],
})
export class AuthModule {}
```

Register `AuthModule` in `src/app.module.ts`.

- [ ] **Step 11: Verify the gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all exit 0.

- [ ] **Step 12: Manual smoke test**

With Redis running and `ADMIN_BOOTSTRAP_EMAIL` / `ADMIN_BOOTSTRAP_PASSWORD` set in `.env`:

```bash
npm run start:dev
```

In a second terminal:

```bash
curl -s -X POST localhost:3000/api/admin/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"owner@example.com","password":"bootstrap-password-1"}'

curl -s localhost:3000/api/admin/v1/auth/me
```

Expected: the login returns `accessToken`/`refreshToken`; the unauthenticated `me` returns 401 with `{"success":false,"error":{"code":"UNAUTHENTICATED",...}}`.

- [ ] **Step 13: Commit**

```bash
git add src/core/auth src/modules/auth src/app.module.ts
git commit -m "feat: add JWT guard, role permissions and auth endpoints

Permissions map to roles in one table rather than role checks scattered
through controllers, so adding a role later is a data change not a grep.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

**Phase 2 exit condition:** a protected route rejects a missing, expired, and reused token; `npm test` passes; the smoke test above behaves as described.

---

# Phase 3 — Asset core and audio

## Task 16: Catalog schema

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/seed.ts`
- Modify: `package.json`, `prisma.config.ts`

**Interfaces:**
- Consumes: `StorageProvider` (Task 8), `AdminUser` (Task 12)
- Produces: the `Asset`, `AssetFile`, `AudioAsset`, `UploadSession`, `User`, `UserEntitlement` tables and their enums, plus a seed script

- [ ] **Step 1: Add the enums to `prisma/schema.prisma`**

```prisma
enum AssetKind {
  audio
  font
  template
}

enum AssetStatus {
  draft
  processing
  ready
  published
  archived
  failed
}

enum Visibility {
  public
  unlisted
  private
}

enum ModerationState {
  pending
  approved
  rejected
}

enum FileRole {
  original
  preview
  thumbnail
  poster
  waveform
  specimen
  font_file
  project
}

enum UploadState {
  pending
  uploaded
  finalized
  expired
  aborted
}

enum AccountStatus {
  active
  suspended
  deleted
}
```

- [ ] **Step 2: Add the catalog models**

```prisma
model Asset {
  id              String          @id @default(cuid())
  kind            AssetKind
  slug            String
  title           String
  description     String?
  authorName      String
  ownerId         String?
  visibility      Visibility      @default(public)
  status          AssetStatus     @default(draft)
  moderationState ModerationState @default(approved)
  createdById     String?
  updatedById     String?
  attributes      Json?
  downloadCount   Int             @default(0)
  favoriteCount   Int             @default(0)
  publishedAt     DateTime?
  createdAt       DateTime        @default(now())
  updatedAt       DateTime        @updatedAt
  deletedAt       DateTime?

  owner     User?           @relation(fields: [ownerId], references: [id])
  createdBy AdminUser?      @relation("AssetCreatedBy", fields: [createdById], references: [id], onDelete: SetNull)
  updatedBy AdminUser?      @relation("AssetUpdatedBy", fields: [updatedById], references: [id], onDelete: SetNull)
  files     AssetFile[]
  audio     AudioAsset?
  sessions  UploadSession[]

  @@unique([kind, slug])
  @@index([kind, status, publishedAt(sort: Desc)])
  @@index([status, deletedAt])
}

model AssetFile {
  id             String   @id @default(cuid())
  assetId        String
  role           FileRole
  storageId      String
  storageKey     String
  deliveryUrl    String?
  mimeType       String
  format         String
  byteSize       Int
  checksumSha256 String?
  width          Int?
  height         Int?
  durationMs     Int?
  variant        Json?
  isPrimary      Boolean  @default(false)
  createdAt      DateTime @default(now())

  asset   Asset           @relation(fields: [assetId], references: [id], onDelete: Cascade)
  storage StorageProvider @relation(fields: [storageId], references: [id])

  @@unique([storageId, storageKey])
  @@index([assetId, role])
  @@index([checksumSha256])
}

model AudioAsset {
  assetId     String  @id
  durationMs  Int
  bpm         Int?
  musicalKey  String?
  isLoopable  Boolean @default(false)
  sampleRate  Int?
  bitrateKbps Int?
  channels    Int?

  asset Asset @relation(fields: [assetId], references: [id], onDelete: Cascade)
}

model UploadSession {
  id           String      @id @default(cuid())
  assetId      String
  role         FileRole
  storageId    String
  storageKey   String
  state        UploadState @default(pending)
  expiresAt    DateTime
  declaredMime String
  declaredSize Int
  createdById  String
  createdAt    DateTime    @default(now())
  finalizedAt  DateTime?

  asset Asset @relation(fields: [assetId], references: [id], onDelete: Cascade)

  @@index([state, expiresAt])
  @@index([assetId])
}

model User {
  id            String        @id @default(cuid())
  email         String?       @unique
  phone         String?       @unique
  displayName   String?
  avatarUrl     String?
  accountStatus AccountStatus @default(active)
  tier          String        @default("free")
  createdAt     DateTime      @default(now())
  updatedAt     DateTime      @updatedAt
  deletedAt     DateTime?

  entitlements UserEntitlement[]
  assets       Asset[]
}

model UserEntitlement {
  id        String    @id @default(cuid())
  userId    String
  sku       String
  source    String
  grantedAt DateTime  @default(now())
  expiresAt DateTime?

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, sku])
}
```

Add the matching back-relations to `AdminUser`:

```prisma
  createdAssets Asset[] @relation("AssetCreatedBy")
  updatedAssets Asset[] @relation("AssetUpdatedBy")
```

- [ ] **Step 3: Delete the obsolete `AudioType` enum and old `AudioAsset` definition**

The original `AudioAsset` model and the `AudioType` enum are replaced. Remove both from `prisma/schema.prisma`.

- [ ] **Step 4: Migrate**

```bash
npx prisma migrate dev --name add_catalog_core
npx prisma generate
```

The old `AudioAsset` table holds two June test rows. The migration will drop it. That is intended — confirm the prompt refers only to `AudioAsset` and its two rows before accepting.

- [ ] **Step 5: Write `prisma/seed.ts`**

```ts
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

loadEnv({ path: resolve(process.cwd(), '.env') });

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../src/generated/prisma/client';
import { EnvelopeCryptoService } from '../src/core/crypto/envelope-crypto.service';

async function main(): Promise<void> {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const prisma = new PrismaClient({ adapter });
  const crypto = new EnvelopeCryptoService(process.env.MASTER_ENCRYPTION_KEY!);

  const existing = await prisma.storageProvider.findFirst({
    where: { isDefault: true },
  });

  if (existing) {
    console.log('Default storage provider already present — nothing to seed.');
    await prisma.$disconnect();
    return;
  }

  const sealed = crypto.encrypt(
    JSON.stringify({
      cloudName: requireEnv('CLOUDINARY_CLOUD_NAME'),
      apiKey: requireEnv('CLOUDINARY_API_KEY'),
      apiSecret: requireEnv('CLOUDINARY_API_SECRET'),
      folder: process.env.CLOUDINARY_AUDIO_FOLDER ?? 'slimshot/audio',
    }),
  );

  await prisma.storageProvider.create({
    data: {
      kind: 'cloudinary',
      name: 'Primary Cloudinary',
      isDefault: true,
      isActive: true,
      configCipher: sealed.cipher,
      keyVersion: sealed.keyVersion,
      publicConfig: { folder: process.env.CLOUDINARY_AUDIO_FOLDER ?? 'slimshot/audio' },
    },
  });

  console.log('Seeded default Cloudinary storage provider.');
  await prisma.$disconnect();
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} must be set to seed the storage provider.`);
  return value;
}

void main();
```

This is the one-time migration path for the Cloudinary credentials currently in `.env` — after seeding, they live encrypted in the database and the env vars can be removed.

- [ ] **Step 6: Wire the seed script**

Add to `package.json` scripts:

```json
"seed": "ts-node prisma/seed.ts"
```

Add `prisma/**` to the eslint env-read exemption list.

- [ ] **Step 7: Run the seed**

```bash
npm run seed
```

Expected: `Seeded default Cloudinary storage provider.` Running it twice must print the "already present" line rather than creating a duplicate.

- [ ] **Step 8: Verify the gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all exit 0.

- [ ] **Step 9: Commit**

```bash
git add prisma package.json eslint.config.mjs
git commit -m "feat: add catalog core schema and storage provider seed

Replaces the standalone AudioAsset table with Asset + AssetFile + AudioAsset.
The seed migrates the Cloudinary credentials out of .env into the encrypted
StorageProvider row, which is where they belong.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 17: The asset kind registry

This is the piece the whole design rests on. If it works, Phases 7 and 8 add fonts and templates without touching ingest, delivery, search, or admin CRUD. If it does not, the design failed and gets fixed here.

**Files:**
- Create: `src/modules/assets/asset-kind.interface.ts`
- Create: `src/modules/assets/kind-registry.ts`
- Create: `src/modules/assets/kind-registry.spec.ts`
- Create: `src/modules/assets/kinds/audio/audio.descriptor.ts`
- Create: `src/modules/assets/kinds/audio/audio.descriptor.spec.ts`

**Interfaces:**
- Consumes: `AssetKind`, `FileRole` enums (Task 16)
- Produces:
  - `interface AssetKindDescriptor { kind; label; accepts; fileRoles; detailDto; processors; buildDetail; toPublicDto }`
  - `ASSET_KIND_DESCRIPTOR` — DI multi-provider token
  - `KindRegistry.get(kind: AssetKind): AssetKindDescriptor`
  - `KindRegistry.all(): AssetKindDescriptor[]`
  - `KindRegistry.assertAccepts(kind, mimeType, byteSize, maxBytes): void`
  - `AUDIO_DESCRIPTOR: AssetKindDescriptor`

- [ ] **Step 1: Write `src/modules/assets/asset-kind.interface.ts`**

Types only — no test.

```ts
import { Type } from '@nestjs/common';

import { AssetKind, FileRole } from '../../generated/prisma/enums';
import { RemoteObject } from '../../core/storage/storage-adapter.interface';

export interface KindFileRole {
  role: FileRole;
  required: boolean;
  multiple: boolean;
}

export interface KindAccepts {
  mimeTypesSetting: string;
  maxBytesSetting: string;
  extensions: string[];
}

export interface PublicAssetFile {
  url: string;
  byteSize: number;
  format: string;
  durationMs?: number;
  width?: number;
  height?: number;
  variant?: Record<string, unknown>;
}

export interface PublicAsset {
  id: string;
  slug: string;
  kind: AssetKind;
  title: string;
  author: string;
  tags: string[];
  files: Record<string, PublicAssetFile>;
  detail: Record<string, unknown>;
  stats: { downloadCount: number };
}

/** The shape the generic asset service hands to a descriptor. */
export interface AssetWithRelations {
  id: string;
  slug: string;
  kind: AssetKind;
  title: string;
  authorName: string;
  downloadCount: number;
  files: Array<{
    role: FileRole;
    deliveryUrl: string | null;
    byteSize: number;
    format: string;
    durationMs: number | null;
    width: number | null;
    height: number | null;
    variant: unknown;
  }>;
  audio?: { durationMs: number; bpm: number | null; isLoopable: boolean } | null;
}

export interface AssetKindDescriptor {
  kind: AssetKind;
  label: string;
  accepts: KindAccepts;
  fileRoles: KindFileRole[];
  detailDto: Type<unknown>;
  processors: string[];
  /** Typed detail row written at finalize, from provider-verified metadata. */
  buildDetail(remote: RemoteObject): Record<string, unknown>;
  toPublicDto(asset: AssetWithRelations): PublicAsset;
}

export const ASSET_KIND_DESCRIPTOR = Symbol('ASSET_KIND_DESCRIPTOR');
```

- [ ] **Step 2: Write the failing registry test**

Create `src/modules/assets/kind-registry.spec.ts`:

```ts
import { BadRequestException } from '@nestjs/common';

import { AssetKind, FileRole } from '../../generated/prisma/enums';
import { AssetKindDescriptor } from './asset-kind.interface';
import { KindRegistry } from './kind-registry';

const FAKE: AssetKindDescriptor = {
  kind: AssetKind.audio,
  label: 'Audio',
  accepts: {
    mimeTypesSetting: 'upload.audio.mimeTypes',
    maxBytesSetting: 'upload.audio.maxBytes',
    extensions: ['.mp3', '.wav'],
  },
  fileRoles: [
    { role: FileRole.original, required: true, multiple: false },
    { role: FileRole.preview, required: false, multiple: false },
  ],
  detailDto: class {},
  processors: ['audio:preview'],
  buildDetail: (remote) => ({ durationMs: remote.durationMs ?? 0 }),
  toPublicDto: () => ({
    id: 'x',
    slug: 'x',
    kind: AssetKind.audio,
    title: 'x',
    author: 'x',
    tags: [],
    files: {},
    detail: {},
    stats: { downloadCount: 0 },
  }),
};

describe('KindRegistry', () => {
  it('resolves a registered descriptor by kind', () => {
    const reg = new KindRegistry([FAKE]);
    expect(reg.get(AssetKind.audio).label).toBe('Audio');
  });

  it('throws for an unregistered kind rather than returning undefined', () => {
    const reg = new KindRegistry([FAKE]);
    expect(() => reg.get(AssetKind.font)).toThrow(/no descriptor registered/i);
  });

  it('lists every registered descriptor', () => {
    expect(new KindRegistry([FAKE]).all()).toHaveLength(1);
  });

  it('rejects duplicate registrations for the same kind at construction', () => {
    expect(() => new KindRegistry([FAKE, FAKE])).toThrow(/duplicate/i);
  });

  it('accepts a file matching the declared mime types and size', () => {
    const reg = new KindRegistry([FAKE]);
    expect(() =>
      reg.assertAccepts(AssetKind.audio, 'audio/mpeg', 1000, ['audio/mpeg'], 50_000),
    ).not.toThrow();
  });

  it('rejects a mime type the kind does not accept', () => {
    const reg = new KindRegistry([FAKE]);
    expect(() =>
      reg.assertAccepts(AssetKind.audio, 'application/zip', 1000, ['audio/mpeg'], 50_000),
    ).toThrow(BadRequestException);
  });

  it('rejects a file over the configured size cap', () => {
    const reg = new KindRegistry([FAKE]);
    expect(() =>
      reg.assertAccepts(AssetKind.audio, 'audio/mpeg', 90_000, ['audio/mpeg'], 50_000),
    ).toThrow(/exceeds/i);
  });

  it('names the required file roles for a kind', () => {
    const reg = new KindRegistry([FAKE]);
    expect(reg.requiredRoles(AssetKind.audio)).toEqual([FileRole.original]);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx jest src/modules/assets/kind-registry.spec.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 4: Write `src/modules/assets/kind-registry.ts`**

```ts
import { BadRequestException, Inject, Injectable } from '@nestjs/common';

import { AssetKind, FileRole } from '../../generated/prisma/enums';
import {
  ASSET_KIND_DESCRIPTOR,
  AssetKindDescriptor,
} from './asset-kind.interface';

@Injectable()
export class KindRegistry {
  private readonly byKind = new Map<AssetKind, AssetKindDescriptor>();

  constructor(
    @Inject(ASSET_KIND_DESCRIPTOR) descriptors: AssetKindDescriptor[],
  ) {
    for (const descriptor of descriptors) {
      if (this.byKind.has(descriptor.kind)) {
        throw new Error(
          `Duplicate asset kind descriptor registered for: ${descriptor.kind}`,
        );
      }
      this.byKind.set(descriptor.kind, descriptor);
    }
  }

  get(kind: AssetKind): AssetKindDescriptor {
    const descriptor = this.byKind.get(kind);
    if (!descriptor) {
      throw new Error(`No descriptor registered for asset kind: ${kind}`);
    }
    return descriptor;
  }

  all(): AssetKindDescriptor[] {
    return [...this.byKind.values()];
  }

  requiredRoles(kind: AssetKind): FileRole[] {
    return this.get(kind)
      .fileRoles.filter((r) => r.required)
      .map((r) => r.role);
  }

  /**
   * Allowed mime types and the size cap are passed in rather than read here,
   * because they live in SettingsService and this class stays synchronous.
   */
  assertAccepts(
    kind: AssetKind,
    mimeType: string,
    byteSize: number,
    allowedMimeTypes: string[],
    maxBytes: number,
  ): void {
    this.get(kind);

    if (!allowedMimeTypes.includes(mimeType)) {
      throw new BadRequestException(
        `${mimeType} is not an accepted type for ${kind}. ` +
          `Allowed: ${allowedMimeTypes.join(', ')}`,
      );
    }

    if (byteSize > maxBytes) {
      throw new BadRequestException(
        `File size ${byteSize} exceeds the configured maximum of ${maxBytes} bytes.`,
      );
    }
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx jest src/modules/assets/kind-registry.spec.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Write the failing audio descriptor test**

Create `src/modules/assets/kinds/audio/audio.descriptor.spec.ts`:

```ts
import { AssetKind, FileRole } from '../../../../generated/prisma/enums';
import { AUDIO_DESCRIPTOR } from './audio.descriptor';

describe('AUDIO_DESCRIPTOR', () => {
  it('declares the audio kind and requires an original file', () => {
    expect(AUDIO_DESCRIPTOR.kind).toBe(AssetKind.audio);
    const original = AUDIO_DESCRIPTOR.fileRoles.find(
      (r) => r.role === FileRole.original,
    );
    expect(original?.required).toBe(true);
  });

  it('points at settings keys rather than hardcoding limits', () => {
    expect(AUDIO_DESCRIPTOR.accepts.maxBytesSetting).toBe('upload.audio.maxBytes');
    expect(AUDIO_DESCRIPTOR.accepts.mimeTypesSetting).toBe('upload.audio.mimeTypes');
  });

  it('builds the detail row from provider-verified duration', () => {
    const detail = AUDIO_DESCRIPTOR.buildDetail({
      storageKey: 'k',
      byteSize: 100,
      format: 'mp3',
      mimeType: 'audio/mpeg',
      durationMs: 145_200,
      deliveryUrl: 'https://cdn/x.mp3',
    });
    expect(detail).toEqual({ durationMs: 145_200 });
  });

  it('defaults duration to zero when the provider reports none', () => {
    const detail = AUDIO_DESCRIPTOR.buildDetail({
      storageKey: 'k',
      byteSize: 100,
      format: 'mp3',
      mimeType: 'audio/mpeg',
      deliveryUrl: 'https://cdn/x.mp3',
    });
    expect(detail).toEqual({ durationMs: 0 });
  });

  it('maps an asset to the public dto with files keyed by role', () => {
    const dto = AUDIO_DESCRIPTOR.toPublicDto({
      id: 'a1',
      slug: 'rise',
      kind: AssetKind.audio,
      title: 'Rise',
      authorName: 'SlimShot',
      downloadCount: 7,
      files: [
        {
          role: FileRole.preview,
          deliveryUrl: 'https://cdn/preview.mp3',
          byteSize: 812_340,
          format: 'mp3',
          durationMs: 145_200,
          width: null,
          height: null,
          variant: null,
        },
      ],
      audio: { durationMs: 145_200, bpm: 120, isLoopable: false },
    });

    expect(dto.files.preview.url).toBe('https://cdn/preview.mp3');
    expect(dto.detail).toEqual({ durationMs: 145_200, bpm: 120, isLoopable: false });
    expect(dto.stats.downloadCount).toBe(7);
  });

  it('omits a file whose delivery url is not yet known', () => {
    const dto = AUDIO_DESCRIPTOR.toPublicDto({
      id: 'a1',
      slug: 'rise',
      kind: AssetKind.audio,
      title: 'Rise',
      authorName: 'SlimShot',
      downloadCount: 0,
      files: [
        {
          role: FileRole.original,
          deliveryUrl: null,
          byteSize: 1,
          format: 'mp3',
          durationMs: null,
          width: null,
          height: null,
          variant: null,
        },
      ],
      audio: { durationMs: 1, bpm: null, isLoopable: false },
    });

    expect(dto.files.original).toBeUndefined();
  });

  it('never exposes the original download url in the public dto', () => {
    const dto = AUDIO_DESCRIPTOR.toPublicDto({
      id: 'a1',
      slug: 'rise',
      kind: AssetKind.audio,
      title: 'Rise',
      authorName: 'SlimShot',
      downloadCount: 0,
      files: [
        {
          role: FileRole.original,
          deliveryUrl: 'https://cdn/original.wav',
          byteSize: 1,
          format: 'wav',
          durationMs: null,
          width: null,
          height: null,
          variant: null,
        },
      ],
      audio: { durationMs: 1, bpm: null, isLoopable: false },
    });

    expect(JSON.stringify(dto)).not.toContain('original.wav');
  });
});
```

The last test encodes a spec rule: the original file is the thing the signed-download endpoint gates, so it must never appear in a browse response.

- [ ] **Step 7: Run to verify it fails**

Run: `npx jest src/modules/assets/kinds/audio`
Expected: FAIL — cannot find module.

- [ ] **Step 8: Write `src/modules/assets/kinds/audio/audio.descriptor.ts`**

```ts
import { AssetKind, FileRole } from '../../../../generated/prisma/enums';
import { RemoteObject } from '../../../../core/storage/storage-adapter.interface';
import {
  AssetKindDescriptor,
  AssetWithRelations,
  PublicAsset,
  PublicAssetFile,
} from '../../asset-kind.interface';
import { AudioDetailDto } from './audio-detail.dto';

/** Roles safe to expose in a browse response. `original` is gated. */
const PUBLIC_ROLES: readonly FileRole[] = [
  FileRole.preview,
  FileRole.thumbnail,
  FileRole.waveform,
];

export const AUDIO_DESCRIPTOR: AssetKindDescriptor = {
  kind: AssetKind.audio,
  label: 'Audio',

  accepts: {
    mimeTypesSetting: 'upload.audio.mimeTypes',
    maxBytesSetting: 'upload.audio.maxBytes',
    extensions: ['.mp3', '.wav', '.aac', '.ogg', '.flac'],
  },

  fileRoles: [
    { role: FileRole.original, required: true, multiple: false },
    { role: FileRole.preview, required: false, multiple: false },
    { role: FileRole.waveform, required: false, multiple: false },
    { role: FileRole.thumbnail, required: false, multiple: false },
  ],

  detailDto: AudioDetailDto,

  processors: ['audio:preview', 'audio:waveform'],

  buildDetail(remote: RemoteObject): Record<string, unknown> {
    return { durationMs: remote.durationMs ?? 0 };
  },

  toPublicDto(asset: AssetWithRelations): PublicAsset {
    const files: Record<string, PublicAssetFile> = {};

    for (const file of asset.files) {
      if (!PUBLIC_ROLES.includes(file.role) || !file.deliveryUrl) continue;

      files[file.role] = {
        url: file.deliveryUrl,
        byteSize: file.byteSize,
        format: file.format,
        ...(file.durationMs !== null ? { durationMs: file.durationMs } : {}),
        ...(file.width !== null ? { width: file.width } : {}),
        ...(file.height !== null ? { height: file.height } : {}),
      };
    }

    return {
      id: asset.id,
      slug: asset.slug,
      kind: asset.kind,
      title: asset.title,
      author: asset.authorName,
      tags: [],
      files,
      detail: {
        durationMs: asset.audio?.durationMs ?? 0,
        bpm: asset.audio?.bpm ?? null,
        isLoopable: asset.audio?.isLoopable ?? false,
      },
      stats: { downloadCount: asset.downloadCount },
    };
  },
};
```

Create `src/modules/assets/kinds/audio/audio-detail.dto.ts`:

```ts
import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class AudioDetailDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  bpm?: number;

  @IsOptional()
  @IsString()
  musicalKey?: string;

  @IsOptional()
  @IsBoolean()
  isLoopable?: boolean;
}
```

Note what is absent: `durationMs`, `byteSize` and `format` are not client-settable. They come from `buildDetail(remote)`.

- [ ] **Step 9: Run to verify it passes**

Run: `npx jest src/modules/assets`
Expected: PASS, 15 tests across both spec files.

- [ ] **Step 10: Verify the gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all exit 0.

- [ ] **Step 11: Commit**

```bash
git add src/modules/assets
git commit -m "feat: add asset kind registry with the audio descriptor

Kinds register a descriptor at boot, so the generic asset service never
switches on kind. Size and mime limits are settings keys, not constants, and
the public dto omits the original file because downloads are gated.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 18: Ingest service — ticket and finalize

The behavioural change that matters: today `mapDirectUploadResult` copies client-supplied `durationSeconds`, `fileSizeBytes`, `previewUrl` and `downloadUrl` straight into the database. After this task, finalize ignores all of that and reads the values back from the storage provider.

**Files:**
- Create: `src/modules/ingest/ingest.service.ts`
- Create: `src/modules/ingest/ingest.service.spec.ts`
- Create: `src/modules/ingest/dto/create-upload-ticket.dto.ts`
- Create: `src/modules/ingest/dto/finalize-upload.dto.ts`
- Create: `src/modules/ingest/ingest.module.ts`

**Interfaces:**
- Consumes: `KindRegistry` (Task 17), `StorageRegistry` (Task 8), `SettingsService` (Task 7), `QueueService` (Task 10), `AuditService` (Task 11), `PrismaService`
- Produces:
  - `IngestService.createTicket(dto: CreateUploadTicketDto, actorId: string): Promise<TicketResponse>`
  - `IngestService.finalize(dto: FinalizeUploadDto, actorId: string): Promise<{ assetId: string; status: AssetStatus }>`
  - `interface TicketResponse { assetId: string; sessionId: string; uploadUrl: string; storageKey: string; fields: Record<string, string>; expiresAt: Date }`

- [ ] **Step 1: Write the DTOs**

Create `src/modules/ingest/dto/create-upload-ticket.dto.ts`:

```ts
import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';

import { AssetKind } from '../../../generated/prisma/enums';

export class CreateUploadTicketDto {
  @IsEnum(AssetKind)
  kind!: AssetKind;

  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  filename!: string;

  @IsString()
  mimeType!: string;

  @IsInt()
  @Min(1)
  byteSize!: number;

  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  title?: string;

  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  author?: string;
}
```

Create `src/modules/ingest/dto/finalize-upload.dto.ts`:

```ts
import { IsString } from 'class-validator';

export class FinalizeUploadDto {
  @IsString()
  sessionId!: string;
}
```

The finalize DTO carries **only** the session id. Everything else is looked up server-side or read from the provider. That is the whole point of the task.

- [ ] **Step 2: Write the failing test**

Create `src/modules/ingest/ingest.service.spec.ts`:

```ts
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { AssetKind, FileRole } from '../../generated/prisma/enums';
import { AUDIO_DESCRIPTOR } from '../assets/kinds/audio/audio.descriptor';
import { KindRegistry } from '../assets/kind-registry';
import { IngestService } from './ingest.service';

const REMOTE = {
  storageKey: 'slimshot/audio/abc',
  byteSize: 812_340,
  format: 'mp3',
  mimeType: 'audio/mpeg',
  durationMs: 145_200,
  deliveryUrl: 'https://cdn/abc.mp3',
};

function build(overrides: { session?: Record<string, unknown> | null } = {}) {
  const adapter = {
    id: 'prov-1',
    kind: 'cloudinary',
    createUploadTicket: jest.fn(async () => ({
      uploadUrl: 'https://api.cloudinary.com/v1_1/demo/video/upload',
      storageKey: 'slimshot/audio/abc',
      fields: { signature: 'sig', api_key: 'key' },
      expiresAt: new Date(Date.now() + 900_000),
    })),
    verifyUpload: jest.fn(async () => REMOTE),
    getDeliveryUrl: jest.fn(() => REMOTE.deliveryUrl),
  };

  const sessions = new Map<string, Record<string, unknown>>();
  if (overrides.session !== undefined && overrides.session !== null) {
    sessions.set(overrides.session.id as string, overrides.session);
  }

  const created: Record<string, unknown>[] = [];

  const prisma = {
    asset: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'asset-1',
        ...data,
      })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'asset-1',
        ...data,
      })),
    },
    uploadSession: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: 'sess-1', ...data };
        sessions.set('sess-1', row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        sessions.get(where.id) ?? null,
      ),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = sessions.get(where.id);
        if (row) Object.assign(row, data);
        return row;
      }),
    },
    assetFile: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return data;
      }),
    },
    audioAsset: { upsert: jest.fn(async () => ({})) },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      typeof fn === 'function' ? fn(prisma) : Promise.all(fn as never),
    ),
  };

  const settingsValues: Record<string, unknown> = {
    'upload.audio.mimeTypes': ['audio/mpeg', 'audio/wav'],
    'upload.audio.maxBytes': 52_428_800,
    'upload.ticketTtlSeconds': 900,
  };

  const svc = new IngestService(
    prisma as never,
    new KindRegistry([AUDIO_DESCRIPTOR]),
    { getDefault: jest.fn(async () => adapter), get: jest.fn(async () => adapter) } as never,
    { get: jest.fn(async (k: string) => settingsValues[k]) } as never,
    { enqueueAssetProcessing: jest.fn(async () => 'job-1') } as never,
    { record: jest.fn(async () => undefined) } as never,
  );

  return { svc, prisma, adapter, created, sessions };
}

describe('IngestService.createTicket', () => {
  const DTO = {
    kind: AssetKind.audio,
    filename: 'Rise Up.mp3',
    mimeType: 'audio/mpeg',
    byteSize: 812_340,
  };

  it('creates a draft asset and an upload session', async () => {
    const { svc, prisma } = build();
    const res = await svc.createTicket(DTO, 'admin-1');

    expect(prisma.asset.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'audio', status: 'draft' }),
      }),
    );
    expect(res.sessionId).toBe('sess-1');
  });

  it('derives a slug from the filename when no title is given', async () => {
    const { svc, prisma } = build();
    await svc.createTicket(DTO, 'admin-1');

    const data = prisma.asset.create.mock.calls[0][0].data as Record<string, string>;
    expect(data.slug).toMatch(/^rise-up/);
    expect(data.title).toBe('Rise Up');
  });

  it('rejects a mime type the kind does not accept', async () => {
    const { svc } = build();
    await expect(
      svc.createTicket({ ...DTO, mimeType: 'application/zip' }, 'admin-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a file larger than the configured cap', async () => {
    const { svc } = build();
    await expect(
      svc.createTicket({ ...DTO, byteSize: 99_999_999 }, 'admin-1'),
    ).rejects.toThrow(/exceeds/i);
  });

  it('never returns the provider api secret in the ticket', async () => {
    const { svc } = build();
    const res = await svc.createTicket(DTO, 'admin-1');
    expect(JSON.stringify(res)).not.toContain('apiSecret');
  });
});

describe('IngestService.finalize', () => {
  function pendingSession() {
    return {
      id: 'sess-1',
      assetId: 'asset-1',
      role: FileRole.original,
      storageId: 'prov-1',
      storageKey: 'slimshot/audio/abc',
      state: 'pending',
      expiresAt: new Date(Date.now() + 600_000),
      declaredMime: 'audio/mpeg',
      declaredSize: 812_340,
      asset: { kind: AssetKind.audio },
    };
  }

  it('reads byte size and duration from the provider, not the client', async () => {
    const { svc, adapter, created } = build({ session: pendingSession() });
    await svc.finalize({ sessionId: 'sess-1' }, 'admin-1');

    expect(adapter.verifyUpload).toHaveBeenCalledWith('slimshot/audio/abc');
    expect(created[0].byteSize).toBe(812_340);
    expect(created[0].durationMs).toBe(145_200);
  });

  it('writes the typed detail row from provider metadata', async () => {
    const { svc, prisma } = build({ session: pendingSession() });
    await svc.finalize({ sessionId: 'sess-1' }, 'admin-1');

    expect(prisma.audioAsset.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ durationMs: 145_200 }),
      }),
    );
  });

  it('moves the asset to processing and enqueues the kind processors', async () => {
    const { svc, prisma } = build({ session: pendingSession() });
    await svc.finalize({ sessionId: 'sess-1' }, 'admin-1');

    expect(prisma.asset.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'processing' }) }),
    );
  });

  it('marks the session finalized so it cannot be replayed', async () => {
    const { svc, sessions } = build({ session: pendingSession() });
    await svc.finalize({ sessionId: 'sess-1' }, 'admin-1');
    expect(sessions.get('sess-1')!.state).toBe('finalized');
  });

  it('rejects a second finalize of the same session', async () => {
    const { svc } = build({ session: { ...pendingSession(), state: 'finalized' } });
    await expect(svc.finalize({ sessionId: 'sess-1' }, 'admin-1')).rejects.toThrow(
      /already finalized/i,
    );
  });

  it('rejects an expired session', async () => {
    const { svc } = build({
      session: { ...pendingSession(), expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(svc.finalize({ sessionId: 'sess-1' }, 'admin-1')).rejects.toThrow(
      /expired/i,
    );
  });

  it('rejects an unknown session id', async () => {
    const { svc } = build({ session: null });
    await expect(svc.finalize({ sessionId: 'nope' }, 'admin-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('marks the asset failed when the object is not in storage', async () => {
    const { svc, adapter, prisma } = build({ session: pendingSession() });
    adapter.verifyUpload.mockRejectedValue(new Error('Uploaded object not found'));

    await expect(svc.finalize({ sessionId: 'sess-1' }, 'admin-1')).rejects.toThrow();
    expect(prisma.asset.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx jest src/modules/ingest`
Expected: FAIL — cannot find module.

- [ ] **Step 4: Write `src/modules/ingest/ingest.service.ts`**

```ts
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { AssetKind, AssetStatus, FileRole } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { QueueService } from '../../core/queue/queue.service';
import { SettingsService } from '../../core/settings/settings.service';
import { StorageRegistry } from '../../core/storage/storage.registry';
import { KindRegistry } from '../assets/kind-registry';
import { CreateUploadTicketDto } from './dto/create-upload-ticket.dto';
import { FinalizeUploadDto } from './dto/finalize-upload.dto';

export interface TicketResponse {
  assetId: string;
  sessionId: string;
  uploadUrl: string;
  storageKey: string;
  fields: Record<string, string>;
  expiresAt: Date;
}

@Injectable()
export class IngestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kinds: KindRegistry,
    private readonly storage: StorageRegistry,
    private readonly settings: SettingsService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
  ) {}

  async createTicket(
    dto: CreateUploadTicketDto,
    actorId: string,
  ): Promise<TicketResponse> {
    const descriptor = this.kinds.get(dto.kind);

    const allowedMimeTypes = await this.settings.get<string[]>(
      descriptor.accepts.mimeTypesSetting,
    );
    const maxBytes = await this.settings.get<number>(
      descriptor.accepts.maxBytesSetting,
    );

    this.kinds.assertAccepts(
      dto.kind,
      dto.mimeType,
      dto.byteSize,
      allowedMimeTypes,
      maxBytes,
    );

    const title = dto.title?.trim() || titleFromFilename(dto.filename);
    const adapter = await this.storage.getDefault();
    const ttlSeconds = await this.settings.get<number>('upload.ticketTtlSeconds');

    const ticket = await adapter.createUploadTicket({
      folder: `slimshot/${dto.kind}`,
      filename: dto.filename,
      mimeType: dto.mimeType,
      ttlSeconds,
    });

    const asset = await this.prisma.asset.create({
      data: {
        kind: dto.kind,
        slug: `${slugify(title)}-${randomUUID().slice(0, 8)}`,
        title,
        authorName: dto.author?.trim() || 'SlimShot',
        status: AssetStatus.draft,
        createdById: actorId,
        updatedById: actorId,
      },
    });

    const session = await this.prisma.uploadSession.create({
      data: {
        assetId: asset.id,
        role: FileRole.original,
        storageId: adapter.id,
        storageKey: ticket.storageKey,
        expiresAt: ticket.expiresAt,
        declaredMime: dto.mimeType,
        declaredSize: dto.byteSize,
        createdById: actorId,
      },
    });

    await this.audit.record({
      actorId,
      actorType: 'admin',
      action: 'asset.upload.ticket',
      entityType: 'Asset',
      entityId: asset.id,
      after: { kind: dto.kind, filename: dto.filename },
    });

    return {
      assetId: asset.id,
      sessionId: session.id,
      uploadUrl: ticket.uploadUrl,
      storageKey: ticket.storageKey,
      fields: ticket.fields,
      expiresAt: ticket.expiresAt,
    };
  }

  async finalize(
    dto: FinalizeUploadDto,
    actorId: string,
  ): Promise<{ assetId: string; status: AssetStatus }> {
    const session = await this.prisma.uploadSession.findUnique({
      where: { id: dto.sessionId },
      include: { asset: true },
    });

    if (!session) throw new NotFoundException('Upload session not found.');

    if (session.state === 'finalized') {
      throw new BadRequestException('This upload session is already finalized.');
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('This upload session has expired.');
    }

    const adapter = await this.storage.get(session.storageId);

    // The only source of truth for size, format and duration is the provider.
    let remote;
    try {
      remote = await adapter.verifyUpload(session.storageKey);
    } catch (error) {
      await this.prisma.asset.update({
        where: { id: session.assetId },
        data: { status: AssetStatus.failed },
      });
      throw new BadRequestException(
        `Upload could not be verified in storage: ${(error as Error).message}`,
      );
    }

    const kind = (session as { asset: { kind: AssetKind } }).asset.kind;
    const descriptor = this.kinds.get(kind);

    await this.prisma.assetFile.create({
      data: {
        assetId: session.assetId,
        role: session.role,
        storageId: session.storageId,
        storageKey: remote.storageKey,
        deliveryUrl: remote.deliveryUrl,
        mimeType: remote.mimeType,
        format: remote.format,
        byteSize: remote.byteSize,
        durationMs: remote.durationMs ?? null,
        width: remote.width ?? null,
        height: remote.height ?? null,
        checksumSha256: remote.checksumSha256 ?? null,
        isPrimary: session.role === FileRole.original,
      },
    });

    const detail = descriptor.buildDetail(remote);
    if (kind === AssetKind.audio) {
      await this.prisma.audioAsset.upsert({
        where: { assetId: session.assetId },
        create: { assetId: session.assetId, ...(detail as { durationMs: number }) },
        update: detail as { durationMs: number },
      });
    }

    await this.prisma.uploadSession.update({
      where: { id: session.id },
      data: { state: 'finalized', finalizedAt: new Date() },
    });

    await this.prisma.asset.update({
      where: { id: session.assetId },
      data: { status: AssetStatus.processing, updatedById: actorId },
    });

    for (const processor of descriptor.processors) {
      await this.queue.enqueueAssetProcessing({
        assetId: session.assetId,
        processor,
      });
    }

    await this.audit.record({
      actorId,
      actorType: 'admin',
      action: 'asset.upload.finalized',
      entityType: 'Asset',
      entityId: session.assetId,
      after: { byteSize: remote.byteSize, durationMs: remote.durationMs },
    });

    return { assetId: session.assetId, status: AssetStatus.processing };
  }
}

function titleFromFilename(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx jest src/modules/ingest`
Expected: PASS, 13 tests.

- [ ] **Step 6: Write `src/modules/ingest/ingest.module.ts`**

```ts
import { Module } from '@nestjs/common';

import { AssetsModule } from '../assets/assets.module';
import { IngestService } from './ingest.service';

@Module({
  imports: [AssetsModule],
  providers: [IngestService],
  exports: [IngestService],
})
export class IngestModule {}
```

- [ ] **Step 7: Verify the gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/modules/ingest
git commit -m "feat: add ingest pipeline with provider-verified finalize

The finalize DTO now carries only a session id. Byte size, format and
duration are read back from the storage provider, so a client can no longer
invent a four-hour track or point downloadUrl at another host. Sessions are
single-use, so finalize cannot be replayed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 19: Asset service — publish lifecycle and admin listing

**Files:**
- Create: `src/modules/assets/asset.service.ts`
- Create: `src/modules/assets/asset.service.spec.ts`
- Create: `src/modules/assets/dto/list-assets.dto.ts`
- Create: `src/modules/assets/dto/update-asset.dto.ts`
- Create: `src/modules/assets/assets.module.ts`

**Interfaces:**
- Consumes: `KindRegistry` (Task 17), `CacheService` (Task 9), `AuditService` (Task 11), `PrismaService`
- Produces:
  - `AssetService.list(query: ListAssetsDto): Promise<{ data: unknown[]; meta: { nextCursor: string | null } }>`
  - `AssetService.getById(id: string): Promise<AssetDetail>`
  - `AssetService.update(id: string, dto: UpdateAssetDto, actorId: string): Promise<AssetDetail>`
  - `AssetService.publish(id: string, actorId: string): Promise<AssetDetail>`
  - `AssetService.unpublish(id: string, actorId: string): Promise<AssetDetail>`
  - `AssetService.softDelete(id: string, actorId: string): Promise<void>`

- [ ] **Step 1: Write the DTOs**

Create `src/modules/assets/dto/list-assets.dto.ts`:

```ts
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

import { AssetKind, AssetStatus } from '../../../generated/prisma/enums';

export class ListAssetsDto {
  @IsOptional()
  @IsEnum(AssetKind)
  kind?: AssetKind;

  @IsOptional()
  @IsEnum(AssetStatus)
  status?: AssetStatus;

  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  q?: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 25;
}
```

Create `src/modules/assets/dto/update-asset.dto.ts`:

```ts
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateAssetDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  authorName?: string;
}
```

- [ ] **Step 2: Write the failing test**

Create `src/modules/assets/asset.service.spec.ts`:

```ts
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { AssetKind, AssetStatus, FileRole } from '../../generated/prisma/enums';
import { AssetService } from './asset.service';
import { KindRegistry } from './kind-registry';
import { AUDIO_DESCRIPTOR } from './kinds/audio/audio.descriptor';

function assetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'asset-1',
    kind: AssetKind.audio,
    slug: 'rise',
    title: 'Rise',
    authorName: 'SlimShot',
    status: AssetStatus.ready,
    downloadCount: 0,
    publishedAt: null,
    deletedAt: null,
    files: [
      {
        role: FileRole.preview,
        deliveryUrl: 'https://cdn/p.mp3',
        byteSize: 1,
        format: 'mp3',
        durationMs: 1,
        width: null,
        height: null,
        variant: null,
      },
    ],
    audio: { durationMs: 1, bpm: null, isLoopable: false },
    ...overrides,
  };
}

function build(rows: Array<Record<string, unknown>> = [assetRow()]) {
  const prisma = {
    asset: {
      findMany: jest.fn(async () => rows),
      findFirst: jest.fn(async ({ where }: { where: { id?: string } }) =>
        rows.find((r) => r.id === where.id && !r.deletedAt) ?? null,
      ),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.find((r) => r.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      }),
    },
  };

  const cache = { bumpGeneration: jest.fn(async () => undefined) };
  const audit = { record: jest.fn(async () => undefined) };

  const svc = new AssetService(
    prisma as never,
    new KindRegistry([AUDIO_DESCRIPTOR]),
    cache as never,
    audit as never,
  );

  return { svc, prisma, cache, audit, rows };
}

describe('AssetService.publish', () => {
  it('publishes a ready asset and stamps publishedAt', async () => {
    const { svc, rows } = build();
    await svc.publish('asset-1', 'admin-1');

    expect(rows[0].status).toBe(AssetStatus.published);
    expect(rows[0].publishedAt).toBeInstanceOf(Date);
  });

  it('refuses to publish an asset still processing', async () => {
    const { svc } = build([assetRow({ status: AssetStatus.processing })]);
    await expect(svc.publish('asset-1', 'admin-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses to publish a failed asset', async () => {
    const { svc } = build([assetRow({ status: AssetStatus.failed })]);
    await expect(svc.publish('asset-1', 'admin-1')).rejects.toThrow(/cannot be published/i);
  });

  it('bumps the cache generation for the kind so browse sees it immediately', async () => {
    const { svc, cache } = build();
    await svc.publish('asset-1', 'admin-1');
    expect(cache.bumpGeneration).toHaveBeenCalledWith('catalog:audio');
  });

  it('writes an audit row naming the actor', async () => {
    const { svc, audit } = build();
    await svc.publish('asset-1', 'admin-1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'asset.publish', actorId: 'admin-1' }),
    );
  });

  it('404s for an unknown asset', async () => {
    const { svc } = build([]);
    await expect(svc.publish('nope', 'admin-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AssetService.unpublish', () => {
  it('returns a published asset to ready and clears publishedAt', async () => {
    const { svc, rows } = build([
      assetRow({ status: AssetStatus.published, publishedAt: new Date() }),
    ]);
    await svc.unpublish('asset-1', 'admin-1');

    expect(rows[0].status).toBe(AssetStatus.ready);
    expect(rows[0].publishedAt).toBeNull();
  });

  it('invalidates the cache so the asset disappears from browse', async () => {
    const { svc, cache } = build([assetRow({ status: AssetStatus.published })]);
    await svc.unpublish('asset-1', 'admin-1');
    expect(cache.bumpGeneration).toHaveBeenCalledWith('catalog:audio');
  });
});

describe('AssetService.softDelete', () => {
  it('sets deletedAt rather than removing the row', async () => {
    const { svc, rows } = build();
    await svc.softDelete('asset-1', 'admin-1');
    expect(rows[0].deletedAt).toBeInstanceOf(Date);
  });

  it('makes the asset unfindable afterwards', async () => {
    const { svc } = build();
    await svc.softDelete('asset-1', 'admin-1');
    await expect(svc.getById('asset-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AssetService.list', () => {
  it('returns a null cursor when the page is not full', async () => {
    const { svc } = build();
    const res = await svc.list({ limit: 25 } as never);
    expect(res.meta.nextCursor).toBeNull();
  });

  it('returns a cursor when a full page is returned', async () => {
    const rows = Array.from({ length: 2 }, (_, i) =>
      assetRow({ id: `asset-${i}`, slug: `s${i}` }),
    );
    const { svc } = build(rows);
    const res = await svc.list({ limit: 2 } as never);
    expect(res.meta.nextCursor).toBe('asset-1');
  });

  it('excludes soft-deleted assets', async () => {
    const { svc, prisma } = build();
    await svc.list({ limit: 25 } as never);
    expect(prisma.asset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ deletedAt: null }) }),
    );
  });
});

describe('AssetService.update', () => {
  it('updates the title and records the actor', async () => {
    const { svc, rows } = build();
    await svc.update('asset-1', { title: 'Rise Higher' }, 'admin-1');

    expect(rows[0].title).toBe('Rise Higher');
    expect(rows[0].updatedById).toBe('admin-1');
  });

  it('invalidates the cache only for a published asset', async () => {
    const { svc, cache } = build([assetRow({ status: AssetStatus.draft })]);
    await svc.update('asset-1', { title: 'x' }, 'admin-1');
    expect(cache.bumpGeneration).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx jest src/modules/assets/asset.service.spec.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 4: Write `src/modules/assets/asset.service.ts`**

```ts
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AssetKind, AssetStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { CacheService } from '../../core/cache/cache.service';
import { AssetWithRelations, PublicAsset } from './asset-kind.interface';
import { ListAssetsDto } from './dto/list-assets.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';
import { KindRegistry } from './kind-registry';

const DETAIL_INCLUDE = { files: true, audio: true } as const;

/** Only a fully processed asset may go live. */
const PUBLISHABLE_FROM: readonly AssetStatus[] = [
  AssetStatus.ready,
  AssetStatus.archived,
];

@Injectable()
export class AssetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kinds: KindRegistry,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  async list(
    query: ListAssetsDto,
  ): Promise<{ data: PublicAsset[]; meta: { nextCursor: string | null } }> {
    const rows = await this.prisma.asset.findMany({
      where: {
        deletedAt: null,
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.q
          ? { title: { contains: query.q, mode: 'insensitive' as const } }
          : {}),
      },
      include: DETAIL_INCLUDE,
      take: query.limit,
      ...(query.cursor
        ? { cursor: { id: query.cursor }, skip: 1 }
        : {}),
      orderBy: { createdAt: 'desc' },
    });

    return {
      data: rows.map((row) => this.toPublic(row as unknown as AssetWithRelations)),
      meta: {
        nextCursor:
          rows.length === query.limit ? (rows[rows.length - 1].id as string) : null,
      },
    };
  }

  async getById(id: string): Promise<PublicAsset> {
    return this.toPublic(await this.load(id));
  }

  async update(
    id: string,
    dto: UpdateAssetDto,
    actorId: string,
  ): Promise<PublicAsset> {
    const before = await this.load(id);

    const updated = await this.prisma.asset.update({
      where: { id },
      data: { ...dto, updatedById: actorId },
      include: DETAIL_INCLUDE,
    });

    // Only a live asset can have a stale cache entry.
    if (before.status === AssetStatus.published) {
      await this.invalidate(before.kind);
    }

    await this.audit.record({
      actorId,
      actorType: 'admin',
      action: 'asset.update',
      entityType: 'Asset',
      entityId: id,
      before: { title: before.title },
      after: dto,
    });

    return this.toPublic(updated as unknown as AssetWithRelations);
  }

  async publish(id: string, actorId: string): Promise<PublicAsset> {
    const asset = await this.load(id);

    if (!PUBLISHABLE_FROM.includes(asset.status)) {
      throw new BadRequestException(
        `An asset with status "${asset.status}" cannot be published. ` +
          `It must finish processing first.`,
      );
    }

    const updated = await this.prisma.asset.update({
      where: { id },
      data: {
        status: AssetStatus.published,
        publishedAt: new Date(),
        updatedById: actorId,
      },
      include: DETAIL_INCLUDE,
    });

    await this.invalidate(asset.kind);
    await this.audit.record({
      actorId,
      actorType: 'admin',
      action: 'asset.publish',
      entityType: 'Asset',
      entityId: id,
    });

    return this.toPublic(updated as unknown as AssetWithRelations);
  }

  async unpublish(id: string, actorId: string): Promise<PublicAsset> {
    const asset = await this.load(id);

    const updated = await this.prisma.asset.update({
      where: { id },
      data: {
        status: AssetStatus.ready,
        publishedAt: null,
        updatedById: actorId,
      },
      include: DETAIL_INCLUDE,
    });

    await this.invalidate(asset.kind);
    await this.audit.record({
      actorId,
      actorType: 'admin',
      action: 'asset.unpublish',
      entityType: 'Asset',
      entityId: id,
    });

    return this.toPublic(updated as unknown as AssetWithRelations);
  }

  async softDelete(id: string, actorId: string): Promise<void> {
    const asset = await this.load(id);

    await this.prisma.asset.update({
      where: { id },
      data: { deletedAt: new Date(), updatedById: actorId },
    });

    await this.invalidate(asset.kind);
    await this.audit.record({
      actorId,
      actorType: 'admin',
      action: 'asset.delete',
      entityType: 'Asset',
      entityId: id,
    });
  }

  private async load(id: string): Promise<AssetWithRelations & { status: AssetStatus }> {
    const row = await this.prisma.asset.findFirst({
      where: { id, deletedAt: null },
      include: DETAIL_INCLUDE,
    });

    if (!row) throw new NotFoundException(`Asset not found: ${id}`);
    return row as unknown as AssetWithRelations & { status: AssetStatus };
  }

  private toPublic(row: AssetWithRelations): PublicAsset {
    return this.kinds.get(row.kind).toPublicDto(row);
  }

  private async invalidate(kind: AssetKind): Promise<void> {
    await this.cache.bumpGeneration(`catalog:${kind}`);
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx jest src/modules/assets/asset.service.spec.ts`
Expected: PASS, 14 tests.

- [ ] **Step 6: Write `src/modules/assets/assets.module.ts`**

```ts
import { Module } from '@nestjs/common';

import { ASSET_KIND_DESCRIPTOR } from './asset-kind.interface';
import { AssetService } from './asset.service';
import { KindRegistry } from './kind-registry';
import { AUDIO_DESCRIPTOR } from './kinds/audio/audio.descriptor';

@Module({
  providers: [
    { provide: ASSET_KIND_DESCRIPTOR, useValue: [AUDIO_DESCRIPTOR] },
    KindRegistry,
    AssetService,
  ],
  exports: [KindRegistry, AssetService],
})
export class AssetsModule {}
```

Adding a kind in Phase 7 means appending one descriptor to that array. Nothing else in the module changes.

- [ ] **Step 7: Verify the gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/modules/assets
git commit -m "feat: add asset service with publish lifecycle and cursor listing

Publishing requires a ready asset, so a half-processed upload cannot go live.
Every state change bumps the per-kind cache generation, which is what replaces
the old 24-hour search TTL.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 20: Admin assets controller and retiring the old module

**Files:**
- Create: `src/modules/admin/admin-assets.controller.ts`
- Create: `src/modules/admin/admin-kinds.controller.ts`
- Create: `src/modules/admin/admin.module.ts`
- Delete: `src/modules/audio/` (entire directory)
- Modify: `src/app.module.ts`, `src/main.ts`

**Interfaces:**
- Consumes: `AssetService` (Task 19), `IngestService` (Task 18), `KindRegistry` (Task 17), `JwtAuthGuard` + `PermissionsGuard` + `RequirePermission` (Task 15)
- Produces: the admin endpoints listed below, all guarded

- [ ] **Step 1: Write `src/modules/admin/admin-assets.controller.ts`**

```ts
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { CurrentUser } from '../../core/auth/current-user.decorator';
import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { RequirePermission } from '../../core/auth/permissions';
import { AssetService } from '../assets/asset.service';
import { ListAssetsDto } from '../assets/dto/list-assets.dto';
import { UpdateAssetDto } from '../assets/dto/update-asset.dto';
import { AccessTokenClaims } from '../auth/token.service';
import { CreateUploadTicketDto } from '../ingest/dto/create-upload-ticket.dto';
import { FinalizeUploadDto } from '../ingest/dto/finalize-upload.dto';
import { IngestService } from '../ingest/ingest.service';

@Controller('api/admin/v1/assets')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminAssetsController {
  constructor(
    private readonly assets: AssetService,
    private readonly ingest: IngestService,
  ) {}

  @Get()
  @RequirePermission('asset.read')
  async list(@Query() query: ListAssetsDto) {
    const { data, meta } = await this.assets.list(query);
    return { success: true as const, data, meta };
  }

  @Get(':id')
  @RequirePermission('asset.read')
  async get(@Param('id') id: string) {
    return { success: true as const, data: await this.assets.getById(id) };
  }

  @Post('upload-ticket')
  @RequirePermission('asset.create')
  async ticket(
    @Body() dto: CreateUploadTicketDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return {
      success: true as const,
      data: await this.ingest.createTicket(dto, user.sub),
    };
  }

  @Post('finalize')
  @RequirePermission('asset.create')
  async finalize(
    @Body() dto: FinalizeUploadDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return { success: true as const, data: await this.ingest.finalize(dto, user.sub) };
  }

  @Patch(':id')
  @RequirePermission('asset.update')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateAssetDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return {
      success: true as const,
      data: await this.assets.update(id, dto, user.sub),
    };
  }

  @Post(':id/publish')
  @RequirePermission('asset.publish')
  async publish(@Param('id') id: string, @CurrentUser() user: AccessTokenClaims) {
    return { success: true as const, data: await this.assets.publish(id, user.sub) };
  }

  @Post(':id/unpublish')
  @RequirePermission('asset.publish')
  async unpublish(@Param('id') id: string, @CurrentUser() user: AccessTokenClaims) {
    return { success: true as const, data: await this.assets.unpublish(id, user.sub) };
  }

  @Delete(':id')
  @RequirePermission('asset.delete')
  async remove(@Param('id') id: string, @CurrentUser() user: AccessTokenClaims) {
    await this.assets.softDelete(id, user.sub);
    return { success: true as const, data: { deleted: true } };
  }
}
```

- [ ] **Step 2: Write `src/modules/admin/admin-kinds.controller.ts`**

```ts
import { Controller, Get, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { RequirePermission } from '../../core/auth/permissions';
import { KindRegistry } from '../assets/kind-registry';

@Controller('api/admin/v1/kinds')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminKindsController {
  constructor(private readonly kinds: KindRegistry) {}

  /** Describes the upload contract so a dashboard can render a form per kind. */
  @Get()
  @RequirePermission('asset.read')
  list() {
    return {
      success: true as const,
      data: this.kinds.all().map((d) => ({
        kind: d.kind,
        label: d.label,
        extensions: d.accepts.extensions,
        fileRoles: d.fileRoles,
      })),
    };
  }
}
```

- [ ] **Step 3: Write `src/modules/admin/admin.module.ts`**

```ts
import { Module } from '@nestjs/common';

import { AssetsModule } from '../assets/assets.module';
import { AuthModule } from '../auth/auth.module';
import { IngestModule } from '../ingest/ingest.module';
import { AdminAssetsController } from './admin-assets.controller';
import { AdminKindsController } from './admin-kinds.controller';

@Module({
  imports: [AssetsModule, IngestModule, AuthModule],
  controllers: [AdminAssetsController, AdminKindsController],
})
export class AdminModule {}
```

- [ ] **Step 4: Delete the old audio module**

```bash
rm -rf src/modules/audio
```

Its responsibilities are now split across `AssetsModule` (catalog), `IngestModule` (upload), and `AdminModule` (HTTP surface). The unauthenticated `/api/v1/audio/upload/sign` endpoint disappears with it — which was the point.

- [ ] **Step 5: Update `src/app.module.ts`**

Remove the `AudioModule` import and entry. The final imports array is:

```ts
imports: [
  ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env'] }),
  PrismaModule,
  CryptoModule,
  SettingsModule,
  RedisModule,
  QueueModule,
  StorageModule,
  AuditModule,
  HealthModule,
  AuthModule,
  AssetsModule,
  IngestModule,
  AdminModule,
],
```

Also remove the now-unused `CacheModule.register(...)` from `@nestjs/cache-manager` — `CacheService` replaces it.

- [ ] **Step 6: Tighten CORS in `src/main.ts`**

Replace the bare `app.enableCors()` with an allowlist read from settings:

```ts
const settings = app.get(SettingsService);
const origins = await settings.get<string[]>('cors.allowedOrigins');
app.enableCors(origins.length > 0 ? { origin: origins, credentials: true } : {});
```

Import `SettingsService` at the top of the file.

- [ ] **Step 7: Verify nothing still references the deleted module**

```bash
grep -rn "modules/audio\|AudioModule\|AudioController" src/ --include=*.ts
```

Expected: no matches.

- [ ] **Step 8: Verify the gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all exit 0.

- [ ] **Step 9: End-to-end smoke test**

With Redis running, the storage provider seeded, and the bootstrap owner created:

```bash
npm run start:dev
```

In a second terminal:

```bash
# 1. The old unauthenticated endpoint must be gone.
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/v1/audio/upload/sign
# Expected: 404

# 2. Admin endpoints must reject anonymous callers.
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/admin/v1/assets
# Expected: 401

# 3. Log in and list assets.
TOKEN=$(curl -s -X POST localhost:3000/api/admin/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"owner@example.com","password":"bootstrap-password-1"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).data.accessToken))")

curl -s localhost:3000/api/admin/v1/assets -H "authorization: Bearer $TOKEN"
# Expected: {"success":true,"data":[],"meta":{"nextCursor":null}}

curl -s localhost:3000/api/admin/v1/kinds -H "authorization: Bearer $TOKEN"
# Expected: one descriptor, kind "audio"
```

Record the three status codes in the commit message. If any differs, STOP and report rather than proceeding.

- [ ] **Step 10: Commit**

```bash
git add src/modules/admin src/app.module.ts src/main.ts
git rm -r --cached src/modules/audio 2>/dev/null || true
git add -A
git commit -m "feat: add guarded admin asset API and retire the audio module

Removes the unauthenticated /api/v1/audio/upload/sign endpoint that handed
Cloudinary signing credentials to any caller. Asset endpoints are generic over
kind, so fonts and templates add no new controller. CORS now reads an
allowlist from settings instead of allowing every origin.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

**Phase 3 exit condition:** the three smoke-test status codes are 404 / 401 / 200; `npm run typecheck && npm run lint && npm test` all pass; an admin can obtain an upload ticket, finalize it, and publish the resulting asset.

---

## Deferred to later plans

These are specified in the design document but are **not** in this plan. Each becomes its own plan once Phases 0–3 execute:

- **Phase 4 — Taxonomy.** Category tree, collections, normalized `Tag`/`AssetTag` with rename/merge/unused-cleanup, licenses. Note that `Asset.categoryId` and `Asset.licenseId` are deliberately omitted from Task 16's schema; they arrive with the tables they reference.
- **Phase 5 — Public delivery.** Catalog read API, tsvector + pg_trgm search, signed downloads with the entitlement checkpoint, `AssetDownload` ledger, `Device` registration, favorites.
- **Phase 6 — App services.** `AppRelease`, `/api/v1/app/update`, `/api/v1/app/config`, and the Vercel proxy cutover.
- **Phase 7 — Fonts.** The real test of the kind registry.
- **Phase 8 — Templates.** Dependency graph and engine schema versioning.
- **Phase 9 — Stats, job visibility, OpenAPI generation.**

Also deferred from Phase 1, because they need a running worker to be meaningful: the audio preview/waveform **processors** themselves (Task 18 enqueues `audio:preview` and `audio:waveform`, but no consumer exists yet, so assets stay in `processing` until an admin publishes them manually), the **orphan reaper**, the **deletion worker**, and the Prometheus `/metrics` endpoint. The first plan of Phase 5 should open with the worker, since public delivery depends on previews existing.
