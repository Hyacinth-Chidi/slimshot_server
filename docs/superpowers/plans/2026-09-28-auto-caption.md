# Auto Caption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the app send extracted audio to our server and get back word-timed captions from whichever speech-to-text provider (Deepgram or ElevenLabs) the owner has made active in the dashboard.

**Architecture:** Provider API keys are stored encrypted in Postgres (`ProviderCredential`) and managed through owner-only admin endpoints plus a Settings → Providers tab in the dashboard. The app registers an anonymous device, uploads audio (multipart) to `POST /api/app/v1/captions`, and polls `GET /api/app/v1/captions/:jobId`. A BullMQ job (id derived from device + Idempotency-Key) calls the active provider's adapter, deletes the temp audio, and keeps the normalized result in Redis for 3 minutes.

**Tech Stack:** NestJS 11, `@nestjs/config` 4, class-validator 0.15, Prisma 7.8 (`@prisma/adapter-pg`), BullMQ 5.81 + `@nestjs/bullmq` 11, `@nestjs/platform-express` (multer), Node 26 global `fetch`/`FormData`/`Blob`, Jest 30. Dashboard: Next.js 16, React 19, TanStack Query 5, shadcn on `radix-ui`, Tailwind v4, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-27-auto-caption-design.md` (read it before starting; this plan argues from it).

**Deliberate refinements of the spec** (all within its intent; reviewers should not flag them):
- Job ids are `cap_` + 32 hex characters. BullMQ refuses a custom id that is all digits, and a bare hex slice can be.
- Devices live in their own module (`src/modules/devices/`), because the credit phase will need device auth too. Captions import it.
- The spec's `TempAudioSweeper` is `CaptionSweeper`. It also prunes finished jobs past the TTL, because BullMQ's `removeOnComplete: { age }` only prunes when another job finishes. It never deletes the audio of a job that is still waiting or running.
- Provider 429 counts as retryable alongside 5xx and network errors.
- For both providers, a key-test 403 counts as "valid key, narrow scope" (the spec says this for ElevenLabs only).
- `result.language` is the language code the app sent, if any, else the provider's detected code. ElevenLabs reports ISO 639-3 (`eng`); Deepgram reports BCP-47 (`en`). The developer guide says so.

## Global Constraints

- Every commit message ends with exactly one trailer line: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never `git stash`. Never `--no-verify`. Branch first; never commit on `main`.
- Never run `prisma migrate dev`, `migrate deploy`, `db push`, `db seed`, or anything else against `DATABASE_URL`. Migrations are assembled from `prisma migrate diff --from-schema … --to-schema …` output and checked offline. The owner runs `npx prisma migrate deploy` at rollout.
- Never print `.env` values. Check only presence, length, or format.
- Only provider API keys live in the database. All other configuration comes from `.env` through a `src/config` namespace. `process.env` is read only inside `src/config/**`, `prisma.config.ts`, `test/**`, `**/*.spec.ts` and `prisma/seed.ts` (ESLint enforces this).
- No caps, quotas or rate limits on captions in this phase (credits come later).
- Audio is deleted the moment the provider call finishes (success, failure no retry can fix, or last attempt). Results are kept `CAPTION_RESULT_TTL_SECONDS` (default 180), then return 404.
- An API key is never returned by any endpoint, never logged, never written to an audit entry, and never appears in an error message (provider messages are scrubbed).
- Response envelope: `{ "success": true, "data": … }` or `{ "success": false, "error": { "code", "message", "details"?, "traceId" } }`.
- Error codes added: `CAPTIONS_UNAVAILABLE` (503), `PROVIDER_FAILED` (job result), `PAYLOAD_TOO_LARGE` (413), `UNSUPPORTED_MEDIA` (415).
- App API base path `/api/app/v1`; admin base `/api/admin/v1`. New permission `providers.manage`, owner only.
- `.env` defaults: `CAPTION_TMP_DIR` = `<os tmp>/slimshot-captions` (created 0700), `CAPTION_MAX_UPLOAD_BYTES` 52428800 (1 MB–200 MB), `CAPTION_RESULT_TTL_SECONDS` 180 (30–3600), `CAPTION_CONCURRENCY` 4 (1–20), `CAPTION_DEEPGRAM_MODEL` `nova-3`, `CAPTION_ELEVENLABS_MODEL` `scribe_v2`, `MASTER_ENCRYPTION_KEY` required, exactly 64 hex.
- Temp audio files are written with mode 0600 (POSIX; Windows ignores modes, so mode assertions skip on `win32`).
- Dashboard: dark only; no shadows; the brand gradient only in its existing four places (logo tile, the two active-nav indicators, the `primary` Button variant), with no new uses; 44px tap targets below `md`; dialogs, tabs and menus come from shadcn/Radix primitives in `components/ui/`, never hand-rolled.
- Shell quirks on this machine: use absolute paths or `git -C`. Write generated files with bash redirection, never PowerShell `Out-File` (it adds a BOM).
- Server checks: `npx jest <path>`, `npm run lint`, `npm run typecheck`, `npm run build`. Dashboard checks: `npm test -- <path>`, `npm run lint`, `npx tsc --noEmit`, `npm run build`.

## Review Focus

1. **The app uploads with no audio content type.** Flutter's `http.MultipartFile.fromPath` sends `application/octet-stream` unless told otherwise. Expected: a 415 `UNSUPPORTED_MEDIA` whose message names the type received, and a developer guide whose Dart snippet sets `contentType`. Pinned in Task 11 (HTTP spec) and Task 12 (guide).
2. **Silent or music-only audio.** Expected: `completed` with `text: ""` and `words: []`, not a failure or a crash when the provider returns no alternative or no words. Pinned in Tasks 3 and 4.
3. **A queue backlog longer than the TTL.** A job waits over 3 minutes behind others. Expected: the sweeper keeps its audio because the job is still waiting. Pinned in Task 10.
4. **A result polled after the TTL that BullMQ has not pruned yet.** BullMQ prunes by age only when another job finishes. Expected: 404 anyway, as the app guide promises. Pinned in Task 9.
5. **The owner replaces a bad key or switches provider.** Expected: the very next caption job uses the new key or provider, not the 60-second cached one. Pinned in Task 5.

---

## File Structure

**Server (`slimshot_server`, branch `feat/auto-caption`)**

| File | Responsibility |
|---|---|
| `src/config/env.validation.ts` (modify) | `MASTER_ENCRYPTION_KEY` and `CAPTION_*` rules |
| `src/config/crypto.config.ts`, `src/config/caption.config.ts` (new) | namespaces `crypto`, `caption` |
| `src/core/crypto/*` (restored) | AES-256-GCM `EnvelopeCryptoService`, `CryptoModule` |
| `prisma/schema.prisma`, `prisma/migrations/20260928120000_add_providers_and_devices/` | `ProviderCredential`, `Device`, enums, partial unique index |
| `src/modules/providers/speech-to-text.provider.ts` | adapter interface, `CaptionResult`, provider display names |
| `src/modules/providers/provider-error.ts` | `ProviderError`, message extraction, key scrubbing |
| `src/modules/providers/provider-http.ts` | timed JSON requests and key probes shared by adapters |
| `src/modules/providers/deepgram.provider.ts`, `elevenlabs.provider.ts` | one adapter each |
| `src/modules/providers/provider.registry.ts` | kind → adapter |
| `src/modules/providers/provider-credentials.service.ts` | encrypted keys, one-active rule, cache, audit |
| `src/modules/providers/provider-params.ts`, `dto/*` | request validation for the admin endpoints |
| `src/modules/providers/providers.module.ts` | wiring (static module: one shared service and cache) |
| `src/modules/admin/admin-providers.controller.ts` | `/api/admin/v1/providers` |
| `src/core/errors/*` (modify) | new codes; honour an explicit `code` in an HttpException body |
| `src/modules/devices/*` | anonymous device registration, token hashing, `DeviceAuthGuard` |
| `src/modules/captions/captions.constants.ts` | queue name, job id, failure encoding, view types |
| `src/modules/captions/captions.service.ts` | start (idempotent) and status |
| `src/modules/captions/caption.worker.ts` | BullMQ processor; deletes audio |
| `src/modules/captions/caption-sweeper.ts` | backstop cleanup of files and finished jobs |
| `src/modules/captions/captions.controller.ts`, `dto/*`, `captions.module.ts` | app endpoints, multer limits |
| `src/app.setup.ts` | global pipe + filter, shared by `main.ts` and the HTTP spec |
| `docs/app-api/auto-caption.md` | guide for the mobile developer |

**Dashboard (`slimshot-admin`, branch `feat/providers-settings`)**

| File | Responsibility |
|---|---|
| `components/ui/tabs.tsx` | shadcn Tabs on `radix-ui`, restyled |
| `lib/auth/profile.ts` | `fetchMe`, `useProfile` (restored) |
| `lib/api/providers.ts` | typed wrappers for the admin providers endpoints |
| `components/settings/provider-key-dialog.tsx` | add/replace key dialog; field never outlives the dialog |
| `components/settings/remove-key-dialog.tsx` | confirmation |
| `components/settings/provider-card.tsx` | one provider: status, actions, test result |
| `components/settings/providers-tab.tsx` | Auto caption section, one card per provider |
| `app/(dashboard)/settings/page.tsx` | owner gate + tabs |
| `components/shell/nav-items.ts`, `sidebar.tsx`, `mobile-top-bar.tsx` | Settings entry (sidebar) and gear (phone top bar) |

---

### Task 0: Branch and commit the spec

**Files:**
- Modify: `docs/superpowers/specs/2026-09-27-auto-caption-design.md:4`

- [ ] **Step 1: Create the branch**

```bash
git -C "C:/Users/HP/Desktop/Slimshot workspace/slimshot_server" switch -c feat/auto-caption
```

- [ ] **Step 2: Mark the spec approved**

Replace line 4 of the spec:

```markdown
**Status:** Approved in conversation; awaiting review of this written spec
```

with:

```markdown
**Status:** Approved (2026-09-28)
```

- [ ] **Step 3: Commit spec and plan**

```bash
cd "C:/Users/HP/Desktop/Slimshot workspace/slimshot_server"
git add docs/superpowers/specs/2026-09-27-auto-caption-design.md docs/superpowers/plans/2026-09-28-auto-caption.md
git commit -m "docs: auto caption design and implementation plan

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1: Configuration and encryption

**Files:**
- Modify: `src/config/env.validation.ts` (imports at top; new fields after `CLOUDINARY_AUDIO_FOLDER`)
- Create: `src/config/crypto.config.ts`, `src/config/caption.config.ts`
- Modify: `src/config/index.ts`, `src/app.module.ts:4-12,31`, `test/setup-env.ts`, `.env.example`
- Test: `src/config/env.validation.spec.ts`
- Create (restored from `3fff7f3^`, trimmed): `src/core/crypto/envelope-crypto.service.ts`, `src/core/crypto/envelope-crypto.service.spec.ts`, `src/core/crypto/crypto.module.ts`
- Test: `src/core/crypto/crypto.module.spec.ts`

**Interfaces:**
- Produces: `captionConfig` / `CaptionConfig` = `{ tmpDir: string; maxUploadBytes: number; resultTtlSeconds: number; concurrency: number; deepgramModel: string; elevenlabsModel: string }`; `cryptoConfig` / `CryptoConfig` = `{ masterKey: string }`; `EnvelopeCryptoService.encrypt(plain: string): SealedValue`, `.decrypt(sealed: SealedValue): string`, where `SealedValue = { cipher: Uint8Array<ArrayBuffer>; keyVersion: number }` (Prisma 7 returns `Bytes` as `Uint8Array<ArrayBuffer>`, so rows pass straight in); `CryptoModule` exports `EnvelopeCryptoService`.

- [ ] **Step 1: Write the failing config tests**

In `src/config/env.validation.spec.ts`:

1. Add imports at the top:

```ts
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { captionConfig } from './caption.config';
import { cryptoConfig } from './crypto.config';
```

2. Add the key to `BASE` (after `CLOUDINARY_API_SECRET: 'secret',`):

```ts
  MASTER_ENCRYPTION_KEY: 'ab'.repeat(32),
```

3. Add `'MASTER_ENCRYPTION_KEY',` to the `it.each([...])('rejects a missing or empty %s'` list.

4. Add these rows to the `it.each([...])('rejects %s=%s'` list:

```ts
    ['CAPTION_MAX_UPLOAD_BYTES', '1000'],
    ['CAPTION_MAX_UPLOAD_BYTES', '209715201'],
    ['CAPTION_RESULT_TTL_SECONDS', '29'],
    ['CAPTION_RESULT_TTL_SECONDS', '3601'],
    ['CAPTION_CONCURRENCY', '0'],
    ['CAPTION_CONCURRENCY', '21'],
    ['MASTER_ENCRYPTION_KEY', 'a'.repeat(63)],
    ['MASTER_ENCRYPTION_KEY', 'g'.repeat(64)],
```

5. Add inside `describe('parseEnv', …)`:

```ts
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
```

6. Add inside `describe('config namespaces', …)`:

```ts
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

  it('exposes the master encryption key', () => {
    process.env = { ...BASE };
    expect(cryptoConfig().masterKey).toBe('ab'.repeat(32));
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx jest src/config/env.validation.spec.ts`
Expected: FAIL. The imports `./caption.config` and `./crypto.config` cannot be found.

- [ ] **Step 3: Add the variables to `Env`**

In `src/config/env.validation.ts`, add below the `class-validator` import:

```ts
import { tmpdir } from 'node:os';
import { join } from 'node:path';
```

Below `const DEFAULT_MIME_TYPES = …;` add:

```ts
const DEFAULT_CAPTION_TMP_DIR = join(tmpdir(), 'slimshot-captions');
```

Inside `class Env`, after `CLOUDINARY_AUDIO_FOLDER = 'slimshot/audio';`, add:

```ts

  // Encrypts the provider API keys stored in the database. It cannot live
  // there itself: it is what decrypts them.
  @Transform(text)
  @IsDefined({ message: 'MASTER_ENCRYPTION_KEY is required' })
  @Matches(/^[0-9a-fA-F]{64}$/, {
    message: 'MASTER_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)',
  })
  MASTER_ENCRYPTION_KEY!: string;

  @Transform(({ value }) => (blank(value) ? DEFAULT_CAPTION_TMP_DIR : String(value).trim()))
  @IsString()
  CAPTION_TMP_DIR = DEFAULT_CAPTION_TMP_DIR;

  @Transform(int(52_428_800))
  @IsInt()
  @Min(1_048_576)
  @Max(209_715_200)
  CAPTION_MAX_UPLOAD_BYTES = 52_428_800;

  @Transform(int(180))
  @IsInt()
  @Min(30)
  @Max(3_600)
  CAPTION_RESULT_TTL_SECONDS = 180;

  @Transform(int(4))
  @IsInt()
  @Min(1)
  @Max(20)
  CAPTION_CONCURRENCY = 4;

  @Transform(({ value }) => (blank(value) ? 'nova-3' : String(value).trim()))
  @IsString()
  CAPTION_DEEPGRAM_MODEL = 'nova-3';

  @Transform(({ value }) => (blank(value) ? 'scribe_v2' : String(value).trim()))
  @IsString()
  CAPTION_ELEVENLABS_MODEL = 'scribe_v2';
```

- [ ] **Step 4: Create the namespaces**

`src/config/crypto.config.ts`:

```ts
import { ConfigType, registerAs } from '@nestjs/config';

import { parseEnv } from './env.validation';

export const cryptoConfig = registerAs('crypto', () => ({
  masterKey: parseEnv(process.env).MASTER_ENCRYPTION_KEY,
}));

export type CryptoConfig = ConfigType<typeof cryptoConfig>;
```

`src/config/caption.config.ts`:

```ts
import { ConfigType, registerAs } from '@nestjs/config';

import { parseEnv } from './env.validation';

export const captionConfig = registerAs('caption', () => {
  const env = parseEnv(process.env);
  return {
    tmpDir: env.CAPTION_TMP_DIR,
    maxUploadBytes: env.CAPTION_MAX_UPLOAD_BYTES,
    resultTtlSeconds: env.CAPTION_RESULT_TTL_SECONDS,
    concurrency: env.CAPTION_CONCURRENCY,
    deepgramModel: env.CAPTION_DEEPGRAM_MODEL,
    elevenlabsModel: env.CAPTION_ELEVENLABS_MODEL,
  };
});

export type CaptionConfig = ConfigType<typeof captionConfig>;
```

Replace `src/config/index.ts` with:

```ts
export { appConfig, type AppConfig } from './app.config';
export { authConfig, type AuthConfig } from './auth.config';
export { captionConfig, type CaptionConfig } from './caption.config';
export { cloudinaryConfig, type CloudinaryEnvConfig } from './cloudinary.config';
export { cryptoConfig, type CryptoConfig } from './crypto.config';
export { databaseConfig, type DatabaseConfig } from './database.config';
export { parseEnv, validate, type Env } from './env.validation';
export { redisConfig, type RedisConfig } from './redis.config';
export { uploadConfig, type UploadConfig, type UploadLimits } from './upload.config';
```

Add to `test/setup-env.ts` (after the Cloudinary lines):

```ts
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY ?? 'ab'.repeat(32);
```

- [ ] **Step 5: Run the config tests**

Run: `npx jest src/config`
Expected: PASS, including `config-module.spec.ts` (it gets the key from `setup-env.ts`).

- [ ] **Step 6: Write the failing crypto tests**

`src/core/crypto/envelope-crypto.service.spec.ts`:

```ts
import { EnvelopeCryptoService } from './envelope-crypto.service';

const KEY = 'a'.repeat(64); // 32 bytes hex

describe('EnvelopeCryptoService', () => {
  const svc = new EnvelopeCryptoService(KEY);

  it('round-trips a value', () => {
    const sealed = svc.encrypt('provider-key-123');
    expect(svc.decrypt(sealed)).toBe('provider-key-123');
  });

  it('never stores plaintext in the ciphertext', () => {
    const sealed = svc.encrypt('provider-key-123');
    expect(Buffer.from(sealed.cipher).toString('utf8')).not.toContain('provider-key-123');
  });

  it('produces different ciphertext each time for the same input', () => {
    const a = svc.encrypt('same');
    const b = svc.encrypt('same');
    expect(Buffer.from(a.cipher).equals(Buffer.from(b.cipher))).toBe(false);
    expect(svc.decrypt(a)).toBe(svc.decrypt(b));
  });

  it('decrypts bytes read back as a plain Uint8Array, the way Prisma returns Bytes', () => {
    const sealed = svc.encrypt('provider-key-123');
    const fromDb = new Uint8Array(sealed.cipher);
    expect(svc.decrypt({ cipher: fromDb, keyVersion: sealed.keyVersion })).toBe('provider-key-123');
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
});
```

`src/core/crypto/crypto.module.spec.ts`:

```ts
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { cryptoConfig } from '../../config';
import { CryptoModule } from './crypto.module';
import { EnvelopeCryptoService } from './envelope-crypto.service';

describe('CryptoModule', () => {
  it('builds the service from the crypto namespace', async () => {
    const moduleRef = await Test.createTestingModule({
      // isGlobal, as in AppModule: CryptoModule injects the namespace without importing ConfigModule.
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [cryptoConfig] }), CryptoModule],
    }).compile();

    const svc = moduleRef.get(EnvelopeCryptoService);
    expect(svc.decrypt(svc.encrypt('round trip'))).toBe('round trip');
  });
});
```

- [ ] **Step 7: Run them to see them fail**

Run: `npx jest src/core/crypto`
Expected: FAIL with "Cannot find module './envelope-crypto.service'".

- [ ] **Step 8: Restore the service (without `mask`: nothing displays a key any more) and wire the module to config**

`src/core/crypto/envelope-crypto.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const MASTER_KEY = Symbol('MASTER_KEY');

export interface SealedValue {
  cipher: Uint8Array<ArrayBuffer>;
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

  /**
   * NOTE: `sealed.keyVersion` is recorded but not yet consulted here — this service
   * holds exactly one key. Rotation requires adding a version→key map and dispatching
   * on `sealed.keyVersion`; until then a rotated key cannot read old values.
   */
  decrypt(sealed: SealedValue): string {
    const data = Buffer.from(sealed.cipher);
    const iv = data.subarray(0, IV_BYTES);
    const tag = data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const body = data.subarray(IV_BYTES + TAG_BYTES);

    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  }
}
```

`src/core/crypto/crypto.module.ts`:

```ts
import { Module } from '@nestjs/common';

import { cryptoConfig, type CryptoConfig } from '../../config';
import { EnvelopeCryptoService, MASTER_KEY } from './envelope-crypto.service';

@Module({
  providers: [
    {
      provide: MASTER_KEY,
      inject: [cryptoConfig.KEY],
      useFactory: (crypto: CryptoConfig): string => crypto.masterKey,
    },
    EnvelopeCryptoService,
  ],
  exports: [EnvelopeCryptoService],
})
export class CryptoModule {}
```

- [ ] **Step 9: Load the namespaces at boot**

In `src/app.module.ts`, add `captionConfig` and `cryptoConfig` to the `./config` import (alphabetical), and change the `load` line to:

```ts
      load: [
        appConfig,
        databaseConfig,
        redisConfig,
        authConfig,
        uploadConfig,
        cloudinaryConfig,
        cryptoConfig,
        captionConfig,
      ],
```

- [ ] **Step 10: Document the variables**

Append to `.env.example`, before the `# One-time bootstrap` block:

```bash
# Encrypts the AI provider API keys stored in the database (required).
# Exactly 64 hex characters. Generate one with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Keep a copy somewhere safe. Without it the stored provider keys cannot be
# read, and they must be entered again in Settings → Providers.
MASTER_ENCRYPTION_KEY=replace_with_64_hex_characters

# Auto caption (speech to text). Provider API keys are managed in the
# dashboard (Settings → Providers), not here.
# Where uploaded audio waits for the provider. Each file is deleted as soon as
# the provider answers. Empty = <system temp>/slimshot-captions.
CAPTION_TMP_DIR=
# Largest audio upload in bytes: 1 MB – 200 MB (default 50 MB).
CAPTION_MAX_UPLOAD_BYTES=52428800
# How long a finished caption can be fetched, in seconds: 30–3600.
CAPTION_RESULT_TTL_SECONDS=180
# Caption jobs processed at once: 1–20.
CAPTION_CONCURRENCY=4
CAPTION_DEEPGRAM_MODEL=nova-3
CAPTION_ELEVENLABS_MODEL=scribe_v2

```

- [ ] **Step 11: Run the tests, lint and typecheck**

Run: `npx jest src/config src/core/crypto && npm run lint && npm run typecheck`
Expected: all PASS, no lint warnings.

- [ ] **Step 12: Commit**

```bash
git add src/config src/core/crypto src/app.module.ts test/setup-env.ts .env.example
git commit -m "feat: caption and encryption settings from env; restore envelope crypto

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Database schema and migration

**Files:**
- Modify: `prisma/schema.prisma` (append at end)
- Create: `prisma/migrations/20260928120000_add_providers_and_devices/migration.sql`
- Regenerate: `src/generated/prisma/**`
- Test: `src/prisma/provider-schema.spec.ts`

**Interfaces:**
- Produces: `ProviderKind` (`deepgram`, `elevenlabs`) and `ProviderCapability` (`speech_to_text`) from `src/generated/prisma/enums`. Prisma delegates `prisma.providerCredential` (compound unique `provider_capability`) and `prisma.device` (unique `tokenHash`).

- [ ] **Step 1: Write the failing test**

`src/prisma/provider-schema.spec.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ProviderCapability, ProviderKind } from '../generated/prisma/enums';

describe('provider schema', () => {
  it('knows both speech-to-text providers', () => {
    expect(Object.values(ProviderKind)).toEqual(['deepgram', 'elevenlabs']);
    expect(Object.values(ProviderCapability)).toEqual(['speech_to_text']);
  });

  it('keeps the index that lets the database refuse two active providers', () => {
    // Prisma's schema language cannot express a partial index, so it lives only
    // in the hand-finished migration. Regenerating the migration would drop it.
    const sql = readFileSync(
      join(__dirname, '../../prisma/migrations/20260928120000_add_providers_and_devices/migration.sql'),
      'utf8',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "ProviderCredential_one_active" ON "ProviderCredential"("capability") WHERE "isActive";',
    );
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx jest src/prisma/provider-schema.spec.ts`
Expected: FAIL. `ProviderKind` is undefined, or the module has no such export.

- [ ] **Step 3: Save the current schema and extend it**

```bash
cd "C:/Users/HP/Desktop/Slimshot workspace/slimshot_server"
SCRATCH="C:/Users/HP/AppData/Local/Temp/claude/c--Users-HP-Desktop-Slimshot-workspace/619feb03-2d15-43b9-b229-470228db81c5/scratchpad"
git show HEAD:prisma/schema.prisma > "$SCRATCH/schema-before.prisma"
```

Append to `prisma/schema.prisma`:

```prisma

enum ProviderKind {
  deepgram
  elevenlabs
}

enum ProviderCapability {
  speech_to_text
}

/// An AI provider's API key, encrypted with MASTER_ENCRYPTION_KEY. At most one
/// row per capability may be active; the migration adds a partial unique index
/// for that, which the schema language cannot express.
model ProviderCredential {
  id           String             @id @default(cuid())
  provider     ProviderKind
  capability   ProviderCapability
  apiKeyCipher Bytes
  keyVersion   Int                @default(1)
  isActive     Boolean            @default(false)
  updatedById  String?
  createdAt    DateTime           @default(now())
  updatedAt    DateTime           @updatedAt

  @@unique([provider, capability])
}

/// An anonymous app install. The app holds the token; only its SHA-256 is kept.
model Device {
  id         String   @id @default(cuid())
  tokenHash  String   @unique
  platform   String?
  appVersion String?
  createdAt  DateTime @default(now())
  lastSeenAt DateTime @default(now())
}
```

Then run `npx prisma format`. It only rewrites the schema file; it does not connect anywhere.

- [ ] **Step 4: Assemble the migration offline**

```bash
mkdir -p prisma/migrations/20260928120000_add_providers_and_devices
npx prisma migrate diff --from-schema "$SCRATCH/schema-before.prisma" --to-schema prisma/schema.prisma --script > "$SCRATCH/generated.sql"
cat "$SCRATCH/generated.sql"
```

The output must create exactly two enums, two tables and two unique indexes (`ProviderCredential_provider_capability_key`, `Device_tokenHash_key`), and nothing else. If it touches any other table, stop: the schema edit went wrong.

Write `prisma/migrations/20260928120000_add_providers_and_devices/migration.sql` so it holds the header below, then the generated SQL unchanged, then the partial index. The expected result:

```sql
-- Auto caption: provider API keys (encrypted) and anonymous app devices.
-- See docs/superpowers/specs/2026-09-27-auto-caption-design.md.

-- CreateEnum
CREATE TYPE "ProviderKind" AS ENUM ('deepgram', 'elevenlabs');

-- CreateEnum
CREATE TYPE "ProviderCapability" AS ENUM ('speech_to_text');

-- CreateTable
CREATE TABLE "ProviderCredential" (
    "id" TEXT NOT NULL,
    "provider" "ProviderKind" NOT NULL,
    "capability" "ProviderCapability" NOT NULL,
    "apiKeyCipher" BYTEA NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "platform" TEXT,
    "appVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProviderCredential_provider_capability_key" ON "ProviderCredential"("provider", "capability");

-- CreateIndex
CREATE UNIQUE INDEX "Device_tokenHash_key" ON "Device"("tokenHash");

-- At most one active provider per capability, enforced by the database itself.
CREATE UNIQUE INDEX "ProviderCredential_one_active" ON "ProviderCredential"("capability") WHERE "isActive";
```

Build it with bash, not PowerShell, so no BOM is written:

```bash
M=prisma/migrations/20260928120000_add_providers_and_devices/migration.sql
{ printf -- '-- Auto caption: provider API keys (encrypted) and anonymous app devices.\n-- See docs/superpowers/specs/2026-09-27-auto-caption-design.md.\n\n'
  cat "$SCRATCH/generated.sql"
  printf -- '\n-- At most one active provider per capability, enforced by the database itself.\nCREATE UNIQUE INDEX "ProviderCredential_one_active" ON "ProviderCredential"("capability") WHERE "isActive";\n'
} > "$M"
head -c 3 "$M" | od -An -tx1   # must NOT start with ef bb bf
```

- [ ] **Step 5: Regenerate the client**

Run: `npx prisma generate`
Expected: "Generated Prisma Client … to ./src/generated/prisma". No database connection is made.

- [ ] **Step 6: Run the test and typecheck**

Run: `npx jest src/prisma/provider-schema.spec.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260928120000_add_providers_and_devices src/generated/prisma src/prisma/provider-schema.spec.ts
git commit -m "feat: provider credential and device tables

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Provider contract, shared HTTP, and the Deepgram adapter

**Files:**
- Create: `src/modules/providers/speech-to-text.provider.ts`, `src/modules/providers/provider-error.ts`, `src/modules/providers/provider-http.ts`, `src/modules/providers/deepgram.provider.ts`
- Test: `src/modules/providers/provider-error.spec.ts`, `src/modules/providers/deepgram.provider.spec.ts`

**Interfaces:**
- Consumes: `captionConfig.KEY` / `CaptionConfig` (Task 1); `ProviderKind` (Task 2).
- Produces:
  - `interface CaptionWord { text: string; start: number; end: number; confidence: number }`
  - `interface CaptionResult { provider: ProviderKind; language: string | null; durationSeconds: number | null; text: string; words: CaptionWord[] }`
  - `interface TranscribeInput { filePath: string; mimeType: string; language?: string }`
  - `interface KeyCheck { ok: boolean; message: string }`
  - `interface SpeechToTextProvider { readonly kind: ProviderKind; transcribe(input: TranscribeInput, apiKey: string): Promise<CaptionResult>; testKey(apiKey: string): Promise<KeyCheck> }`
  - `const PROVIDER_NAMES: Record<ProviderKind, string>`
  - `class ProviderError extends Error { readonly provider: ProviderKind; readonly status: number; get retryable(): boolean }`
  - `providerMessage(body: unknown, fallback: string): string`, `scrub(text: string, secret: string): string`
  - `requestJson<T>(provider, url, init, apiKey, timeoutMs?): Promise<T>`, `probeKey(provider, url, headers, apiKey): Promise<KeyCheck>`
  - `DeepgramProvider` (injectable, `kind = 'deepgram'`)

- [ ] **Step 1: Write the failing tests**

`src/modules/providers/provider-error.spec.ts`:

```ts
import { ProviderKind } from '../../generated/prisma/enums';
import { ProviderError, providerMessage, scrub } from './provider-error';

describe('providerMessage', () => {
  it.each([
    ['Deepgram', { err_code: 'INVALID_AUTH', err_msg: 'Invalid credentials.' }, 'Invalid credentials.'],
    ['a plain message', { message: 'Too many requests' }, 'Too many requests'],
    ['ElevenLabs detail object', { detail: { status: 'invalid_api_key', message: 'Invalid API key' } }, 'Invalid API key'],
    ['ElevenLabs detail string', { detail: 'Not found' }, 'Not found'],
    ['ElevenLabs validation list', { detail: [{ loc: ['body', 'file'], msg: 'field required' }] }, 'field required'],
  ])('reads %s', (_label, body, expected) => {
    expect(providerMessage(body, 'fallback')).toBe(expected);
  });

  it('falls back when the body says nothing useful', () => {
    expect(providerMessage(null, 'fallback')).toBe('fallback');
    expect(providerMessage({ unrelated: true }, 'fallback')).toBe('fallback');
  });
});

describe('scrub', () => {
  it('removes every copy of the secret', () => {
    expect(scrub('bad key abc12345 (abc12345)', 'abc12345')).toBe('bad key [redacted] ([redacted])');
  });
});

describe('ProviderError.retryable', () => {
  it.each([
    [500, true],
    [503, true],
    [429, true],
    [400, false],
    [401, false],
    [413, false],
  ])('HTTP %i → %s', (status, retryable) => {
    expect(new ProviderError(ProviderKind.deepgram, status, 'x').retryable).toBe(retryable);
  });
});
```

`src/modules/providers/deepgram.provider.spec.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeepgramProvider } from './deepgram.provider';
import { ProviderError } from './provider-error';

const KEY = 'dg-test-key-0123456789';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const FIXTURE = {
  metadata: { duration: 2.5 },
  results: {
    channels: [
      {
        detected_language: 'en',
        alternatives: [
          {
            transcript: 'Hello world.',
            words: [
              { word: 'hello', punctuated_word: 'Hello', start: 0.08, end: 0.4, confidence: 0.99 },
              { word: 'world', punctuated_word: 'world.', start: 0.4, end: 0.9, confidence: 0.97 },
            ],
          },
        ],
      },
    ],
  },
};

describe('DeepgramProvider', () => {
  const provider = new DeepgramProvider({ deepgramModel: 'nova-3' } as never);
  let dir: string;
  let audioPath: string;
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dg-'));
    audioPath = join(dir, 'clip.audio');
    writeFileSync(audioPath, Buffer.from('fake-audio'));
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('posts the raw audio with the model, formatting and language detection', async () => {
    fetchMock.mockResolvedValue(json(200, FIXTURE));
    await provider.transcribe({ filePath: audioPath, mimeType: 'audio/mp4' }, KEY);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe('https://api.deepgram.com/v1/listen');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      model: 'nova-3',
      smart_format: 'true',
      punctuate: 'true',
      detect_language: 'true',
    });
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ authorization: `Token ${KEY}`, 'content-type': 'audio/mp4' });
    expect(Buffer.from(init.body as Uint8Array).toString()).toBe('fake-audio');
  });

  it('sends the requested language instead of detecting one', async () => {
    fetchMock.mockResolvedValue(json(200, FIXTURE));
    await provider.transcribe({ filePath: audioPath, mimeType: 'audio/mp4', language: 'fr' }, KEY);

    const u = new URL(fetchMock.mock.calls[0][0] as string);
    expect(u.searchParams.get('language')).toBe('fr');
    expect(u.searchParams.has('detect_language')).toBe(false);
  });

  it('normalizes words: punctuated text, seconds, confidence', async () => {
    fetchMock.mockResolvedValue(json(200, FIXTURE));
    const result = await provider.transcribe({ filePath: audioPath, mimeType: 'audio/mp4' }, KEY);

    expect(result).toEqual({
      provider: 'deepgram',
      language: 'en',
      durationSeconds: 2.5,
      text: 'Hello world.',
      words: [
        { text: 'Hello', start: 0.08, end: 0.4, confidence: 0.99 },
        { text: 'world.', start: 0.4, end: 0.9, confidence: 0.97 },
      ],
    });
  });

  it('reports the requested language rather than a detected one', async () => {
    fetchMock.mockResolvedValue(json(200, FIXTURE));
    const result = await provider.transcribe(
      { filePath: audioPath, mimeType: 'audio/mp4', language: 'yo' },
      KEY,
    );
    expect(result.language).toBe('yo');
  });

  it('returns an empty caption for silence instead of failing', async () => {
    fetchMock.mockResolvedValue(json(200, { metadata: { duration: 3 }, results: { channels: [{ alternatives: [] }] } }));
    const result = await provider.transcribe({ filePath: audioPath, mimeType: 'audio/mp4' }, KEY);

    expect(result).toMatchObject({ text: '', words: [], durationSeconds: 3 });
  });

  it('maps a refusal to a non-retryable ProviderError with the provider message and no key', async () => {
    fetchMock.mockResolvedValue(json(400, { err_code: 'Bad Request', err_msg: `Corrupt audio (key ${KEY})` }));

    const error = await provider
      .transcribe({ filePath: audioPath, mimeType: 'audio/mp4' }, KEY)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(400);
    expect((error as ProviderError).retryable).toBe(false);
    expect((error as ProviderError).message).toBe('Corrupt audio (key [redacted])');
  });

  it('marks an outage as retryable', async () => {
    fetchMock.mockResolvedValue(json(503, { err_msg: 'Service unavailable' }));
    const error = await provider
      .transcribe({ filePath: audioPath, mimeType: 'audio/mp4' }, KEY)
      .catch((e: unknown) => e);
    expect((error as ProviderError).retryable).toBe(true);
  });

  describe('testKey', () => {
    it('probes the projects endpoint with the key', async () => {
      fetchMock.mockResolvedValue(json(200, { projects: [] }));
      await expect(provider.testKey(KEY)).resolves.toEqual({ ok: true, message: 'Key works.' });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.deepgram.com/v1/projects');
      expect(init.headers).toEqual({ authorization: `Token ${KEY}` });
    });

    it('reports a rejected key with the provider message', async () => {
      fetchMock.mockResolvedValue(json(401, { err_msg: 'Invalid credentials.' }));
      const check = await provider.testKey(KEY);
      expect(check.ok).toBe(false);
      expect(check.message).toBe('Deepgram rejected this key: Invalid credentials.');
    });

    it('reports an unreachable provider without throwing', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      const check = await provider.testKey(KEY);
      expect(check.ok).toBe(false);
      expect(check.message).toMatch(/Could not reach Deepgram/);
    });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx jest src/modules/providers`
Expected: FAIL with "Cannot find module './provider-error'" and "'./deepgram.provider'".

- [ ] **Step 3: Write the contract and shared helpers**

`src/modules/providers/speech-to-text.provider.ts`:

```ts
import { ProviderKind } from '../../generated/prisma/enums';

export interface CaptionWord {
  /** One spoken word, punctuation attached ("channel."). */
  text: string;
  /** Seconds from the start of the uploaded audio. */
  start: number;
  end: number;
  /** 0–1. */
  confidence: number;
}

export interface CaptionResult {
  provider: ProviderKind;
  /** The code the app asked for, else the provider's detected code (en, eng, …). */
  language: string | null;
  durationSeconds: number | null;
  text: string;
  words: CaptionWord[];
}

export interface TranscribeInput {
  filePath: string;
  mimeType: string;
  language?: string;
}

export interface KeyCheck {
  ok: boolean;
  message: string;
}

/**
 * One speech-to-text vendor. Adding a vendor is one class implementing this
 * plus one ProviderKind value; nothing else learns its name.
 */
export interface SpeechToTextProvider {
  readonly kind: ProviderKind;
  transcribe(input: TranscribeInput, apiKey: string): Promise<CaptionResult>;
  testKey(apiKey: string): Promise<KeyCheck>;
}

export const PROVIDER_NAMES: Record<ProviderKind, string> = {
  [ProviderKind.deepgram]: 'Deepgram',
  [ProviderKind.elevenlabs]: 'ElevenLabs',
};
```

`src/modules/providers/provider-error.ts`:

```ts
import { ProviderKind } from '../../generated/prisma/enums';

/** A provider answered with a non-2xx status. */
export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderKind,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  /** Worth one more try: the provider was down or throttling, not refusing the request itself. */
  get retryable(): boolean {
    return this.status >= 500 || this.status === 429;
  }
}

/** Pulls a human message out of the error bodies Deepgram and ElevenLabs send. */
export function providerMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const b = body as Record<string, unknown>;

  if (typeof b.err_msg === 'string') return b.err_msg; // Deepgram
  if (typeof b.message === 'string') return b.message;

  const detail = b.detail; // ElevenLabs
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    const first = detail[0] as { msg?: unknown } | undefined;
    if (typeof first?.msg === 'string') return first.msg;
  } else if (detail && typeof detail === 'object') {
    const message = (detail as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }

  return fallback;
}

/** Providers sometimes echo the credential back; it must never reach a log, a job result or the dashboard. */
export function scrub(text: string, secret: string): string {
  return secret ? text.split(secret).join('[redacted]') : text;
}
```

`src/modules/providers/provider-http.ts`:

```ts
import { ProviderKind } from '../../generated/prisma/enums';
import { ProviderError, providerMessage, scrub } from './provider-error';
import { PROVIDER_NAMES, type KeyCheck } from './speech-to-text.provider';

/** Long enough for a long video's audio; short enough that a hung socket frees its worker slot. */
export const TRANSCRIBE_TIMEOUT_MS = 10 * 60_000;
const KEY_CHECK_TIMEOUT_MS = 15_000;

/**
 * Sends a request and parses the JSON answer. A non-2xx becomes a
 * ProviderError carrying the provider's own message with the key scrubbed
 * out. Network failures and timeouts are rethrown untouched: the worker
 * treats them as worth a retry.
 */
export async function requestJson<T>(
  provider: ProviderKind,
  url: string,
  init: RequestInit,
  apiKey: string,
  timeoutMs = TRANSCRIBE_TIMEOUT_MS,
): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const body: unknown = await res.json().catch(() => null);
  const name = PROVIDER_NAMES[provider];

  if (!res.ok) {
    const message = providerMessage(body, `${name} returned HTTP ${res.status}.`);
    throw new ProviderError(provider, res.status, scrub(message, apiKey));
  }
  if (body === null) {
    // Reported as a 502 so the worker retries it like any other outage.
    throw new ProviderError(provider, 502, `${name} returned an unreadable response.`);
  }
  return body as T;
}

/** Asks the provider whether a key is valid, without spending any credit. Never throws. */
export async function probeKey(
  provider: ProviderKind,
  url: string,
  headers: Record<string, string>,
  apiKey: string,
): Promise<KeyCheck> {
  const name = PROVIDER_NAMES[provider];
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(KEY_CHECK_TIMEOUT_MS) });
  } catch {
    return {
      ok: false,
      message: `Could not reach ${name}. Check the server's internet connection and try again.`,
    };
  }

  if (res.ok) return { ok: true, message: 'Key works.' };

  // 403: the key authenticated but lacks the scope this probe endpoint needs.
  // Transcription uses a different scope, so the key is still usable.
  if (res.status === 403) {
    return {
      ok: true,
      message: 'Key works. (It cannot read account details, which Auto caption does not need.)',
    };
  }

  const body: unknown = await res.json().catch(() => null);
  const detail = scrub(providerMessage(body, `HTTP ${res.status}`), apiKey);
  if (res.status === 401) return { ok: false, message: `${name} rejected this key: ${detail}` };
  return { ok: false, message: `${name} returned an error: ${detail}` };
}
```

- [ ] **Step 4: Write the Deepgram adapter**

`src/modules/providers/deepgram.provider.ts`:

```ts
import { readFile } from 'node:fs/promises';

import { Inject, Injectable } from '@nestjs/common';

import { captionConfig, type CaptionConfig } from '../../config';
import { ProviderKind } from '../../generated/prisma/enums';
import { probeKey, requestJson } from './provider-http';
import type {
  CaptionResult,
  KeyCheck,
  SpeechToTextProvider,
  TranscribeInput,
} from './speech-to-text.provider';

const API = 'https://api.deepgram.com/v1';

interface DeepgramWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  confidence: number;
}

interface DeepgramResponse {
  metadata?: { duration?: number };
  results?: {
    channels?: Array<{
      detected_language?: string;
      alternatives?: Array<{ transcript?: string; words?: DeepgramWord[] }>;
    }>;
  };
}

@Injectable()
export class DeepgramProvider implements SpeechToTextProvider {
  readonly kind = ProviderKind.deepgram;

  constructor(@Inject(captionConfig.KEY) private readonly cfg: CaptionConfig) {}

  async transcribe(input: TranscribeInput, apiKey: string): Promise<CaptionResult> {
    const params = new URLSearchParams({
      model: this.cfg.deepgramModel,
      smart_format: 'true',
      punctuate: 'true',
    });
    if (input.language) params.set('language', input.language);
    else params.set('detect_language', 'true');

    const audio = await readFile(input.filePath);
    const body = await requestJson<DeepgramResponse>(
      this.kind,
      `${API}/listen?${params.toString()}`,
      {
        method: 'POST',
        headers: { authorization: `Token ${apiKey}`, 'content-type': input.mimeType },
        body: audio,
      },
      apiKey,
    );

    const channel = body.results?.channels?.[0];
    const alternative = channel?.alternatives?.[0];
    // Silence is an answer: no alternative, or one without words, is an empty
    // caption rather than a failure.
    const words = (alternative?.words ?? []).map((w) => ({
      text: w.punctuated_word ?? w.word,
      start: w.start,
      end: w.end,
      confidence: w.confidence,
    }));

    return {
      provider: this.kind,
      language: input.language ?? channel?.detected_language ?? null,
      durationSeconds: body.metadata?.duration ?? null,
      text: alternative?.transcript ?? '',
      words,
    };
  }

  testKey(apiKey: string): Promise<KeyCheck> {
    return probeKey(this.kind, `${API}/projects`, { authorization: `Token ${apiKey}` }, apiKey);
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `npx jest src/modules/providers && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/providers
git commit -m "feat: speech-to-text contract and Deepgram adapter

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: ElevenLabs adapter and the registry

**Files:**
- Create: `src/modules/providers/elevenlabs.provider.ts`, `src/modules/providers/provider.registry.ts`
- Test: `src/modules/providers/elevenlabs.provider.spec.ts`, `src/modules/providers/provider.registry.spec.ts`

**Interfaces:**
- Consumes: everything Task 3 produces.
- Produces: `ElevenLabsProvider` (`kind = 'elevenlabs'`); `ProviderRegistry.speechToTextFor(kind: ProviderKind): SpeechToTextProvider`, whose constructor takes `(deepgram: DeepgramProvider, elevenlabs: ElevenLabsProvider)`.

- [ ] **Step 1: Write the failing tests**

`src/modules/providers/elevenlabs.provider.spec.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ElevenLabsProvider } from './elevenlabs.provider';
import { ProviderError } from './provider-error';

const KEY = 'el-test-key-0123456789';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const FIXTURE = {
  language_code: 'eng',
  language_probability: 0.98,
  text: 'Hello (laughs) world!',
  audio_duration_secs: 1.5,
  words: [
    { text: 'Hello', type: 'word', start: 0, end: 0.5, logprob: -0.1 },
    { text: ' ', type: 'spacing', start: 0.5, end: 0.5, logprob: 0 },
    { text: '(laughs)', type: 'audio_event', start: 0.5, end: 0.8, logprob: 0 },
    { text: 'world!', type: 'word', start: 0.8, end: 1.2, logprob: 0 },
  ],
};

describe('ElevenLabsProvider', () => {
  const provider = new ElevenLabsProvider({ elevenlabsModel: 'scribe_v2' } as never);
  let dir: string;
  let audioPath: string;
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'el-'));
    audioPath = join(dir, 'clip.audio');
    writeFileSync(audioPath, Buffer.from('fake-audio'));
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('posts multipart with the model, word timestamps and no audio events', async () => {
    fetchMock.mockResolvedValue(json(200, FIXTURE));
    await provider.transcribe({ filePath: audioPath, mimeType: 'audio/mp4' }, KEY);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'xi-api-key': KEY });

    const form = init.body as FormData;
    expect(form.get('model_id')).toBe('scribe_v2');
    expect(form.get('timestamps_granularity')).toBe('word');
    expect(form.get('tag_audio_events')).toBe('false');
    expect(form.has('language_code')).toBe(false);
    const file = form.get('file') as File;
    expect(file.type).toBe('audio/mp4');
    expect(await file.text()).toBe('fake-audio');
  });

  it('passes a requested language', async () => {
    fetchMock.mockResolvedValue(json(200, FIXTURE));
    await provider.transcribe({ filePath: audioPath, mimeType: 'audio/mp4', language: 'yo' }, KEY);
    expect((fetchMock.mock.calls[0][1]?.body as FormData).get('language_code')).toBe('yo');
  });

  it('keeps spoken words only and turns log-probability into 0–1 confidence', async () => {
    fetchMock.mockResolvedValue(json(200, FIXTURE));
    const result = await provider.transcribe({ filePath: audioPath, mimeType: 'audio/mp4' }, KEY);

    expect(result).toEqual({
      provider: 'elevenlabs',
      language: 'eng',
      durationSeconds: 1.5,
      text: 'Hello (laughs) world!',
      words: [
        { text: 'Hello', start: 0, end: 0.5, confidence: 0.905 },
        { text: 'world!', start: 0.8, end: 1.2, confidence: 1 },
      ],
    });
  });

  it('falls back to the last word end when the duration is missing', async () => {
    // undefined drops out of JSON.stringify, so the field is simply absent.
    fetchMock.mockResolvedValue(json(200, { ...FIXTURE, audio_duration_secs: undefined }));
    const result = await provider.transcribe({ filePath: audioPath, mimeType: 'audio/mp4' }, KEY);
    expect(result.durationSeconds).toBe(1.2);
  });

  it('returns an empty caption for silence instead of failing', async () => {
    fetchMock.mockResolvedValue(json(200, { language_code: 'eng', text: '', words: [] }));
    const result = await provider.transcribe({ filePath: audioPath, mimeType: 'audio/mp4' }, KEY);
    expect(result).toMatchObject({ text: '', words: [], durationSeconds: null });
  });

  it.each([
    [401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } }, 'Invalid API key'],
    [422, { detail: [{ loc: ['body', 'file'], msg: 'field required' }] }, 'field required'],
  ])('maps HTTP %i to a ProviderError with the provider message', async (status, body, message) => {
    fetchMock.mockResolvedValue(json(status, body));
    const error = await provider
      .transcribe({ filePath: audioPath, mimeType: 'audio/mp4' }, KEY)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(status);
    expect((error as ProviderError).message).toBe(message);
  });

  describe('testKey', () => {
    it('probes the user endpoint with the key', async () => {
      fetchMock.mockResolvedValue(json(200, { subscription: {} }));
      await expect(provider.testKey(KEY)).resolves.toEqual({ ok: true, message: 'Key works.' });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.elevenlabs.io/v1/user');
      expect(init.headers).toEqual({ 'xi-api-key': KEY });
    });

    it('treats 403 as a valid key without the user scope', async () => {
      fetchMock.mockResolvedValue(json(403, { detail: { message: 'missing_permissions' } }));
      await expect(provider.testKey(KEY)).resolves.toMatchObject({ ok: true });
    });

    it('reports a rejected key', async () => {
      fetchMock.mockResolvedValue(json(401, { detail: { message: 'Invalid API key' } }));
      await expect(provider.testKey(KEY)).resolves.toEqual({
        ok: false,
        message: 'ElevenLabs rejected this key: Invalid API key',
      });
    });
  });
});
```

`src/modules/providers/provider.registry.spec.ts`:

```ts
import { ProviderKind } from '../../generated/prisma/enums';
import { DeepgramProvider } from './deepgram.provider';
import { ElevenLabsProvider } from './elevenlabs.provider';
import { ProviderRegistry } from './provider.registry';

describe('ProviderRegistry', () => {
  const cfg = { deepgramModel: 'nova-3', elevenlabsModel: 'scribe_v2' } as never;
  const registry = new ProviderRegistry(new DeepgramProvider(cfg), new ElevenLabsProvider(cfg));

  it.each(Object.values(ProviderKind))('has a speech-to-text adapter for %s', (kind) => {
    expect(registry.speechToTextFor(kind).kind).toBe(kind);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx jest src/modules/providers/elevenlabs.provider.spec.ts src/modules/providers/provider.registry.spec.ts`
Expected: FAIL with "Cannot find module './elevenlabs.provider'".

- [ ] **Step 3: Write the adapter and the registry**

`src/modules/providers/elevenlabs.provider.ts`:

```ts
import { readFile } from 'node:fs/promises';

import { Inject, Injectable } from '@nestjs/common';

import { captionConfig, type CaptionConfig } from '../../config';
import { ProviderKind } from '../../generated/prisma/enums';
import { probeKey, requestJson } from './provider-http';
import type {
  CaptionResult,
  KeyCheck,
  SpeechToTextProvider,
  TranscribeInput,
} from './speech-to-text.provider';

const API = 'https://api.elevenlabs.io/v1';

interface ElevenLabsWord {
  text: string;
  type: 'word' | 'spacing' | 'audio_event';
  start?: number | null;
  end?: number | null;
  logprob?: number;
}

interface ElevenLabsResponse {
  language_code?: string;
  text?: string;
  words?: ElevenLabsWord[];
  audio_duration_secs?: number | null;
}

/** ElevenLabs reports log-probability (−∞…0); the app gets 0–1, three decimals. */
function toConfidence(logprob: number | undefined): number {
  const p = Math.exp(logprob ?? 0);
  if (!Number.isFinite(p)) return 0;
  return Math.round(Math.min(1, Math.max(0, p)) * 1_000) / 1_000;
}

@Injectable()
export class ElevenLabsProvider implements SpeechToTextProvider {
  readonly kind = ProviderKind.elevenlabs;

  constructor(@Inject(captionConfig.KEY) private readonly cfg: CaptionConfig) {}

  async transcribe(input: TranscribeInput, apiKey: string): Promise<CaptionResult> {
    const audio = await readFile(input.filePath);
    const form = new FormData();
    form.append('model_id', this.cfg.elevenlabsModel);
    form.append('file', new Blob([audio], { type: input.mimeType }), 'audio');
    form.append('timestamps_granularity', 'word');
    form.append('tag_audio_events', 'false');
    if (input.language) form.append('language_code', input.language);

    const body = await requestJson<ElevenLabsResponse>(
      this.kind,
      `${API}/speech-to-text`,
      { method: 'POST', headers: { 'xi-api-key': apiKey }, body: form },
      apiKey,
    );

    // Spacing and sound events arrive as "words" too; captions want speech only.
    const words = (body.words ?? [])
      .filter((w) => w.type === 'word')
      .map((w) => {
        const start = w.start ?? 0;
        return { text: w.text, start, end: w.end ?? start, confidence: toConfidence(w.logprob) };
      });

    return {
      provider: this.kind,
      language: input.language ?? body.language_code ?? null,
      durationSeconds: body.audio_duration_secs ?? (words.length > 0 ? words[words.length - 1].end : null),
      text: body.text ?? '',
      words,
    };
  }

  testKey(apiKey: string): Promise<KeyCheck> {
    return probeKey(this.kind, `${API}/user`, { 'xi-api-key': apiKey }, apiKey);
  }
}
```

`src/modules/providers/provider.registry.ts`:

```ts
import { Injectable } from '@nestjs/common';

import { ProviderKind } from '../../generated/prisma/enums';
import { DeepgramProvider } from './deepgram.provider';
import { ElevenLabsProvider } from './elevenlabs.provider';
import type { SpeechToTextProvider } from './speech-to-text.provider';

@Injectable()
export class ProviderRegistry {
  private readonly speechToText: ReadonlyMap<ProviderKind, SpeechToTextProvider>;

  constructor(deepgram: DeepgramProvider, elevenlabs: ElevenLabsProvider) {
    this.speechToText = new Map<ProviderKind, SpeechToTextProvider>([
      [deepgram.kind, deepgram],
      [elevenlabs.kind, elevenlabs],
    ]);
  }

  speechToTextFor(kind: ProviderKind): SpeechToTextProvider {
    const adapter = this.speechToText.get(kind);
    // The registry spec pins one adapter per ProviderKind, so this means a new
    // enum value shipped without its adapter.
    if (!adapter) throw new Error(`No speech-to-text adapter is registered for ${kind}.`);
    return adapter;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx jest src/modules/providers && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/providers
git commit -m "feat: ElevenLabs adapter and provider registry

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Provider credentials service

**Files:**
- Create: `src/modules/providers/provider-credentials.service.ts`, `src/modules/providers/providers.module.ts`
- Test: `src/modules/providers/provider-credentials.service.spec.ts`

**Interfaces:**
- Consumes: `EnvelopeCryptoService`, `CryptoModule` (Task 1); `ProviderRegistry`, `PROVIDER_NAMES`, `KeyCheck`, `SpeechToTextProvider` (Tasks 3–4); `PrismaService`; `AuditService.record(entry)`.
- Produces:
  - `interface ProviderStatus { provider: ProviderKind; capability: ProviderCapability; configured: boolean; active: boolean; updatedAt: Date | null }`
  - `interface ActiveProvider { adapter: SpeechToTextProvider; apiKey: string }`
  - `ProviderCredentialsService` with `list(capability)`, `setKey(provider, capability, apiKey, adminId)`, `removeKey(provider, capability, adminId)`, `activate(provider, capability, adminId): Promise<ProviderStatus[]>`, `deactivate(…): Promise<ProviderStatus[]>`, `test(provider, capability): Promise<KeyCheck>`, `getActive(capability): Promise<ActiveProvider | null>`
  - `ProvidersModule` exporting `ProviderCredentialsService`. It is a plain static module, so the admin side and the caption worker share one instance and one cache. Do not make it dynamic or request-scoped.

- [ ] **Step 1: Write the failing tests**

`src/modules/providers/provider-credentials.service.spec.ts`:

```ts
import { ConflictException, UnprocessableEntityException } from '@nestjs/common';

import { EnvelopeCryptoService } from '../../core/crypto/envelope-crypto.service';
import { ProviderCapability, ProviderKind } from '../../generated/prisma/enums';
import { ProviderCredentialsService } from './provider-credentials.service';

const STT = ProviderCapability.speech_to_text;

interface Row {
  id: string;
  provider: ProviderKind;
  capability: ProviderCapability;
  apiKeyCipher: Uint8Array<ArrayBuffer>;
  keyVersion: number;
  isActive: boolean;
  updatedById: string | null;
  updatedAt: Date;
}

type Where = Record<string, unknown> & {
  provider_capability?: { provider: ProviderKind; capability: ProviderCapability };
};

function matches(row: Row, where: Where = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'provider_capability') {
      const pc = value as NonNullable<Where['provider_capability']>;
      return row.provider === pc.provider && row.capability === pc.capability;
    }
    return (row as unknown as Record<string, unknown>)[key] === value;
  });
}

function build(seed: Array<{ provider: ProviderKind; key: string; isActive?: boolean }> = []) {
  const crypto = new EnvelopeCryptoService('ab'.repeat(32));
  const rows: Row[] = seed.map((s, i) => ({
    id: `cred-${i + 1}`,
    provider: s.provider,
    capability: STT,
    apiKeyCipher: crypto.encrypt(s.key).cipher,
    keyVersion: 1,
    isActive: s.isActive ?? false,
    updatedById: null,
    updatedAt: new Date('2026-09-28T10:00:00Z'),
  }));

  const prisma = {
    providerCredential: {
      findMany: jest.fn(async ({ where }: { where: Where }) => rows.filter((r) => matches(r, where))),
      findUnique: jest.fn(async ({ where }: { where: Where }) => rows.find((r) => matches(r, where)) ?? null),
      findFirst: jest.fn(async ({ where }: { where: Where }) => rows.find((r) => matches(r, where)) ?? null),
      upsert: jest.fn(
        async ({ where, create, update }: { where: Where; create: Partial<Row>; update: Partial<Row> }) => {
          const existing = rows.find((r) => matches(r, where));
          if (existing) {
            Object.assign(existing, update, { updatedAt: new Date() });
            return existing;
          }
          const row = { id: `cred-${rows.length + 1}`, isActive: false, updatedAt: new Date(), ...create } as Row;
          rows.push(row);
          return row;
        },
      ),
      deleteMany: jest.fn(async ({ where }: { where: Where }) => {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i -= 1) if (matches(rows[i], where)) rows.splice(i, 1);
        return { count: before - rows.length };
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Where; data: Partial<Row> }) => {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      }),
      update: jest.fn(async ({ where, data }: { where: Where; data: Partial<Row> }) => {
        const row = rows.find((r) => matches(r, where));
        if (!row) throw Object.assign(new Error('not found'), { code: 'P2025' });
        Object.assign(row, data);
        return row;
      }),
    },
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };

  const adapters = {
    [ProviderKind.deepgram]: { kind: ProviderKind.deepgram, testKey: jest.fn(async () => ({ ok: true, message: 'Key works.' })), transcribe: jest.fn() },
    [ProviderKind.elevenlabs]: { kind: ProviderKind.elevenlabs, testKey: jest.fn(async () => ({ ok: true, message: 'Key works.' })), transcribe: jest.fn() },
  };
  const registry = { speechToTextFor: jest.fn((kind: ProviderKind) => adapters[kind]) };
  const audit = { record: jest.fn(async (_entry: unknown) => undefined) };

  const svc = new ProviderCredentialsService(prisma as never, crypto, registry as never, audit as never);
  return { svc, rows, prisma, audit, adapters, crypto };
}

describe('ProviderCredentialsService.list', () => {
  it('lists every provider, configured or not, and never the key', async () => {
    const { svc } = build([{ provider: ProviderKind.deepgram, key: 'dg-secret-key-1', isActive: true }]);
    const list = await svc.list(STT);

    expect(list).toEqual([
      { provider: 'deepgram', capability: STT, configured: true, active: true, updatedAt: new Date('2026-09-28T10:00:00Z') },
      { provider: 'elevenlabs', capability: STT, configured: false, active: false, updatedAt: null },
    ]);
    expect(JSON.stringify(list)).not.toMatch(/dg-secret-key-1|apiKeyCipher/);
  });
});

describe('ProviderCredentialsService.setKey', () => {
  it('stores the trimmed key encrypted', async () => {
    const { svc, rows, crypto } = build();
    await svc.setKey(ProviderKind.deepgram, STT, '  dg-secret-key-1  ', 'admin-1');

    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0].apiKeyCipher).toString('utf8')).not.toContain('dg-secret-key-1');
    expect(crypto.decrypt({ cipher: rows[0].apiKeyCipher, keyVersion: rows[0].keyVersion })).toBe('dg-secret-key-1');
    expect(rows[0].updatedById).toBe('admin-1');
  });

  it.each(['short', 'x'.repeat(513), '   seven  '])('rejects a key of the wrong length: %j', async (key) => {
    const { svc, rows } = build();
    await expect(svc.setKey(ProviderKind.deepgram, STT, key, 'admin-1')).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(rows).toHaveLength(0);
  });

  it('replaces an existing key and keeps the provider active', async () => {
    const { svc, rows, crypto } = build([{ provider: ProviderKind.deepgram, key: 'dg-old-key-123', isActive: true }]);
    await svc.setKey(ProviderKind.deepgram, STT, 'dg-new-key-456', 'admin-1');

    expect(rows).toHaveLength(1);
    expect(rows[0].isActive).toBe(true);
    expect(crypto.decrypt({ cipher: rows[0].apiKeyCipher, keyVersion: 1 })).toBe('dg-new-key-456');
  });
});

describe('ProviderCredentialsService.activate', () => {
  it('refuses a provider without a key', async () => {
    const { svc } = build();
    await expect(svc.activate(ProviderKind.deepgram, STT, 'admin-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('activates one provider and turns the other off', async () => {
    const { svc, rows } = build([
      { provider: ProviderKind.deepgram, key: 'dg-secret-key-1', isActive: true },
      { provider: ProviderKind.elevenlabs, key: 'el-secret-key-1' },
    ]);
    const list = await svc.activate(ProviderKind.elevenlabs, STT, 'admin-1');

    expect(rows.filter((r) => r.isActive).map((r) => r.provider)).toEqual(['elevenlabs']);
    expect(list.filter((s) => s.active).map((s) => s.provider)).toEqual(['elevenlabs']);
  });

  it('is a no-op, without an audit entry, when already active', async () => {
    const { svc, audit } = build([{ provider: ProviderKind.deepgram, key: 'dg-secret-key-1', isActive: true }]);
    await svc.activate(ProviderKind.deepgram, STT, 'admin-1');
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('ProviderCredentialsService.removeKey and deactivate', () => {
  it('removing the key of the active provider leaves no provider active', async () => {
    const { svc } = build([{ provider: ProviderKind.deepgram, key: 'dg-secret-key-1', isActive: true }]);
    await svc.removeKey(ProviderKind.deepgram, STT, 'admin-1');

    expect((await svc.list(STT)).some((s) => s.configured || s.active)).toBe(false);
    await expect(svc.getActive(STT)).resolves.toBeNull();
  });

  it('removing a key that is not there is a quiet no-op', async () => {
    const { svc, audit } = build();
    await svc.removeKey(ProviderKind.deepgram, STT, 'admin-1');
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('turns a provider off', async () => {
    const { svc } = build([{ provider: ProviderKind.deepgram, key: 'dg-secret-key-1', isActive: true }]);
    const list = await svc.deactivate(ProviderKind.deepgram, STT, 'admin-1');
    expect(list.find((s) => s.provider === 'deepgram')).toMatchObject({ configured: true, active: false });
  });
});

describe('ProviderCredentialsService.test', () => {
  it('decrypts the key and asks the adapter', async () => {
    const { svc, adapters } = build([{ provider: ProviderKind.elevenlabs, key: 'el-secret-key-1' }]);
    await expect(svc.test(ProviderKind.elevenlabs, STT)).resolves.toEqual({ ok: true, message: 'Key works.' });
    expect(adapters.elevenlabs.testKey).toHaveBeenCalledWith('el-secret-key-1');
  });

  it('says so when no key is saved', async () => {
    const { svc } = build();
    await expect(svc.test(ProviderKind.deepgram, STT)).resolves.toEqual({
      ok: false,
      message: 'No key saved for Deepgram.',
    });
  });
});

describe('ProviderCredentialsService.getActive', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns the active adapter with its decrypted key, or null', async () => {
    const { svc, adapters } = build([{ provider: ProviderKind.deepgram, key: 'dg-secret-key-1', isActive: true }]);
    await expect(svc.getActive(STT)).resolves.toEqual({ adapter: adapters.deepgram, apiKey: 'dg-secret-key-1' });

    const empty = build();
    await expect(empty.svc.getActive(STT)).resolves.toBeNull();
  });

  it('caches for 60 seconds', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { svc, prisma } = build([{ provider: ProviderKind.deepgram, key: 'dg-secret-key-1', isActive: true }]);

    await svc.getActive(STT);
    await svc.getActive(STT);
    expect(prisma.providerCredential.findFirst).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_000_000 + 60_001);
    await svc.getActive(STT);
    expect(prisma.providerCredential.findFirst).toHaveBeenCalledTimes(2);
  });

  it('uses a replaced key at once, not the cached one', async () => {
    const { svc } = build([{ provider: ProviderKind.deepgram, key: 'dg-bad-key-000', isActive: true }]);
    await svc.getActive(STT); // warms the cache

    await svc.setKey(ProviderKind.deepgram, STT, 'dg-good-key-111', 'admin-1');
    await expect(svc.getActive(STT)).resolves.toMatchObject({ apiKey: 'dg-good-key-111' });
  });

  it('uses a newly activated provider at once', async () => {
    const { svc } = build([
      { provider: ProviderKind.deepgram, key: 'dg-secret-key-1', isActive: true },
      { provider: ProviderKind.elevenlabs, key: 'el-secret-key-1' },
    ]);
    await svc.getActive(STT);

    await svc.activate(ProviderKind.elevenlabs, STT, 'admin-1');
    await expect(svc.getActive(STT)).resolves.toMatchObject({ apiKey: 'el-secret-key-1' });
  });
});

describe('ProviderCredentialsService audit', () => {
  it('records every change with provider and capability, and never the key', async () => {
    const { svc, audit } = build([{ provider: ProviderKind.elevenlabs, key: 'el-secret-key-1' }]);
    await svc.setKey(ProviderKind.deepgram, STT, 'dg-secret-key-1', 'admin-1');
    await svc.activate(ProviderKind.deepgram, STT, 'admin-1');
    await svc.deactivate(ProviderKind.deepgram, STT, 'admin-1');
    await svc.removeKey(ProviderKind.deepgram, STT, 'admin-1');

    const calls = audit.record.mock.calls.map(([entry]) => entry as { action: string; after: unknown });
    expect(calls.map((c) => c.action)).toEqual([
      'provider.key.set',
      'provider.activated',
      'provider.deactivated',
      'provider.key.removed',
    ]);
    expect(calls[0]).toMatchObject({ actorId: 'admin-1', actorType: 'admin', entityType: 'ProviderCredential', after: { provider: 'deepgram', capability: STT } });
    expect(JSON.stringify(audit.record.mock.calls)).not.toMatch(/secret-key/);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx jest src/modules/providers/provider-credentials.service.spec.ts`
Expected: FAIL with "Cannot find module './provider-credentials.service'".

- [ ] **Step 3: Write the service and the module**

`src/modules/providers/provider-credentials.service.ts`:

```ts
import { ConflictException, Injectable, UnprocessableEntityException } from '@nestjs/common';

import { AuditService } from '../../core/audit/audit.service';
import { EnvelopeCryptoService } from '../../core/crypto/envelope-crypto.service';
import { ProviderCapability, ProviderKind } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { ProviderRegistry } from './provider.registry';
import { PROVIDER_NAMES, type KeyCheck, type SpeechToTextProvider } from './speech-to-text.provider';

export interface ProviderStatus {
  provider: ProviderKind;
  capability: ProviderCapability;
  configured: boolean;
  active: boolean;
  updatedAt: Date | null;
}

export interface ActiveProvider {
  adapter: SpeechToTextProvider;
  apiKey: string;
}

const ACTIVE_CACHE_MS = 60_000;
const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 512;

/**
 * Owns ProviderCredential. Keys go in encrypted and only come out decrypted
 * for a provider call or a key test; nothing here returns one to a caller
 * outside the server.
 */
@Injectable()
export class ProviderCredentialsService {
  // Decrypting per caption job would be a DB read plus AES per job. Every
  // change below clears this, so a replaced key or a switched provider is
  // used by the very next job.
  private readonly activeCache = new Map<
    ProviderCapability,
    { value: ActiveProvider | null; expiresAt: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: EnvelopeCryptoService,
    private readonly registry: ProviderRegistry,
    private readonly audit: AuditService,
  ) {}

  async list(capability: ProviderCapability): Promise<ProviderStatus[]> {
    const rows = await this.prisma.providerCredential.findMany({
      where: { capability },
      select: { provider: true, isActive: true, updatedAt: true },
    });
    return Object.values(ProviderKind).map((provider) => {
      const row = rows.find((r) => r.provider === provider);
      return {
        provider,
        capability,
        configured: row !== undefined,
        active: row?.isActive ?? false,
        updatedAt: row?.updatedAt ?? null,
      };
    });
  }

  async setKey(
    provider: ProviderKind,
    capability: ProviderCapability,
    apiKey: string,
    adminId: string,
  ): Promise<void> {
    const key = apiKey.trim();
    if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH) {
      throw new UnprocessableEntityException(
        `apiKey must be ${MIN_KEY_LENGTH}–${MAX_KEY_LENGTH} characters.`,
      );
    }

    const sealed = this.crypto.encrypt(key);
    const row = await this.prisma.providerCredential.upsert({
      where: { provider_capability: { provider, capability } },
      create: {
        provider,
        capability,
        apiKeyCipher: sealed.cipher,
        keyVersion: sealed.keyVersion,
        updatedById: adminId,
      },
      update: { apiKeyCipher: sealed.cipher, keyVersion: sealed.keyVersion, updatedById: adminId },
      select: { id: true },
    });
    this.activeCache.clear();

    await this.audit.record({
      actorId: adminId,
      actorType: 'admin',
      action: 'provider.key.set',
      entityType: 'ProviderCredential',
      entityId: row.id,
      after: { provider, capability },
    });
  }

  async removeKey(
    provider: ProviderKind,
    capability: ProviderCapability,
    adminId: string,
  ): Promise<void> {
    const { count } = await this.prisma.providerCredential.deleteMany({
      where: { provider, capability },
    });
    this.activeCache.clear();
    if (count === 0) return;

    await this.audit.record({
      actorId: adminId,
      actorType: 'admin',
      action: 'provider.key.removed',
      entityType: 'ProviderCredential',
      after: { provider, capability },
    });
  }

  async activate(
    provider: ProviderKind,
    capability: ProviderCapability,
    adminId: string,
  ): Promise<ProviderStatus[]> {
    const row = await this.prisma.providerCredential.findUnique({
      where: { provider_capability: { provider, capability } },
      select: { id: true, isActive: true },
    });
    if (!row) {
      throw new ConflictException(
        `Add an API key for ${PROVIDER_NAMES[provider]} before making it active.`,
      );
    }

    if (!row.isActive) {
      // Deactivate first, in the same transaction: the partial unique index
      // refuses two active rows even for an instant.
      await this.prisma.$transaction([
        this.prisma.providerCredential.updateMany({
          where: { capability, isActive: true },
          data: { isActive: false, updatedById: adminId },
        }),
        this.prisma.providerCredential.update({
          where: { id: row.id },
          data: { isActive: true, updatedById: adminId },
        }),
      ]);
      this.activeCache.clear();

      await this.audit.record({
        actorId: adminId,
        actorType: 'admin',
        action: 'provider.activated',
        entityType: 'ProviderCredential',
        entityId: row.id,
        after: { provider, capability },
      });
    }

    return this.list(capability);
  }

  async deactivate(
    provider: ProviderKind,
    capability: ProviderCapability,
    adminId: string,
  ): Promise<ProviderStatus[]> {
    const { count } = await this.prisma.providerCredential.updateMany({
      where: { provider, capability, isActive: true },
      data: { isActive: false, updatedById: adminId },
    });

    if (count > 0) {
      this.activeCache.clear();
      await this.audit.record({
        actorId: adminId,
        actorType: 'admin',
        action: 'provider.deactivated',
        entityType: 'ProviderCredential',
        after: { provider, capability },
      });
    }

    return this.list(capability);
  }

  async test(provider: ProviderKind, capability: ProviderCapability): Promise<KeyCheck> {
    const row = await this.prisma.providerCredential.findUnique({
      where: { provider_capability: { provider, capability } },
      select: { apiKeyCipher: true, keyVersion: true },
    });
    if (!row) return { ok: false, message: `No key saved for ${PROVIDER_NAMES[provider]}.` };

    const apiKey = this.crypto.decrypt({ cipher: row.apiKeyCipher, keyVersion: row.keyVersion });
    return this.registry.speechToTextFor(provider).testKey(apiKey);
  }

  /** The provider caption jobs should use right now, or null when none is active. */
  async getActive(capability: ProviderCapability): Promise<ActiveProvider | null> {
    const cached = this.activeCache.get(capability);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const row = await this.prisma.providerCredential.findFirst({
      where: { capability, isActive: true },
      select: { provider: true, apiKeyCipher: true, keyVersion: true },
    });
    const value = row
      ? {
          adapter: this.registry.speechToTextFor(row.provider),
          apiKey: this.crypto.decrypt({ cipher: row.apiKeyCipher, keyVersion: row.keyVersion }),
        }
      : null;

    this.activeCache.set(capability, { value, expiresAt: Date.now() + ACTIVE_CACHE_MS });
    return value;
  }
}
```

`src/modules/providers/providers.module.ts`:

```ts
import { Module } from '@nestjs/common';

import { CryptoModule } from '../../core/crypto/crypto.module';
import { DeepgramProvider } from './deepgram.provider';
import { ElevenLabsProvider } from './elevenlabs.provider';
import { ProviderCredentialsService } from './provider-credentials.service';
import { ProviderRegistry } from './provider.registry';

// Static on purpose: admin endpoints and the caption worker must share one
// ProviderCredentialsService, so a key change clears the cache the worker reads.
@Module({
  imports: [CryptoModule],
  providers: [DeepgramProvider, ElevenLabsProvider, ProviderRegistry, ProviderCredentialsService],
  exports: [ProviderCredentialsService],
})
export class ProvidersModule {}
```

(`PrismaModule` and `AuditModule` are already global, so they need no import here.)

- [ ] **Step 4: Run the tests, lint and typecheck**

Run: `npx jest src/modules/providers && npm run lint && npm run typecheck`
Expected: PASS. If `prisma.providerCredential` is missing from the types, Task 2's `npx prisma generate` did not run.

- [ ] **Step 5: Commit**

```bash
git add src/modules/providers
git commit -m "feat: encrypted provider credentials with one active provider

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Admin providers endpoints

**Files:**
- Modify: `src/core/auth/permissions.ts:5-17,38-42`
- Test: `src/core/auth/permissions.spec.ts`, `src/core/auth/admin-routes.spec.ts`
- Create: `src/modules/providers/provider-params.ts`, `src/modules/providers/dto/capability.dto.ts`, `src/modules/providers/dto/set-provider-key.dto.ts`
- Test: `src/modules/providers/provider-params.spec.ts`
- Create: `src/modules/admin/admin-providers.controller.ts`
- Test: `src/modules/admin/admin-providers.controller.spec.ts`
- Modify: `src/modules/admin/admin.module.ts`

**Interfaces:**
- Consumes: `ProviderCredentialsService`, `ProvidersModule` (Task 5).
- Produces:
  - Permission `'providers.manage'` (owner only).
  - `assertProvider(value: unknown): ProviderKind`, `assertCapability(value: unknown): ProviderCapability` (both throw 422).
  - Endpoints:
    - `GET /api/admin/v1/providers?capability=` → `ProviderStatus[]`
    - `PUT /:provider/key` → `{ configured: true }`
    - `DELETE /:provider/key?capability=` → `{ configured: false }`
    - `POST /:provider/activate` → `ProviderStatus[]`
    - `POST /:provider/deactivate` → `ProviderStatus[]`
    - `POST /:provider/test` → `KeyCheck`
    - The three POSTs return 200.

- [ ] **Step 1: Write the failing tests**

Add to `src/core/auth/permissions.spec.ts`, inside the `describe`:

```ts
  it('only owner may manage AI provider keys', () => {
    expect(roleHas(AdminRole.owner, 'providers.manage')).toBe(true);
    expect(roleHas(AdminRole.admin, 'providers.manage')).toBe(false);
    expect(roleHas(AdminRole.editor, 'providers.manage')).toBe(false);
    expect(roleHas(AdminRole.viewer, 'providers.manage')).toBe(false);
  });
```

`src/modules/providers/provider-params.spec.ts`:

```ts
import { UnprocessableEntityException } from '@nestjs/common';

import { assertCapability, assertProvider } from './provider-params';

describe('provider params', () => {
  it('accepts known values', () => {
    expect(assertProvider('deepgram')).toBe('deepgram');
    expect(assertProvider('elevenlabs')).toBe('elevenlabs');
    expect(assertCapability('speech_to_text')).toBe('speech_to_text');
  });

  it.each([undefined, '', 'openai', 'Deepgram', ['deepgram']])('rejects provider %j with 422', (value) => {
    expect(() => assertProvider(value)).toThrow(UnprocessableEntityException);
  });

  it('names the allowed values', () => {
    expect(() => assertCapability('tts')).toThrow('capability must be one of: speech_to_text.');
  });
});
```

`src/modules/admin/admin-providers.controller.spec.ts`:

```ts
import { UnprocessableEntityException } from '@nestjs/common';

import { AdminProvidersController } from './admin-providers.controller';

const STT = 'speech_to_text' as const;
const user = { sub: 'admin-1', email: 'o@example.com', role: 'owner' } as never;

function build() {
  const list = [{ provider: 'deepgram', capability: STT, configured: true, active: true, updatedAt: null }];
  const credentials = {
    list: jest.fn(async () => list),
    setKey: jest.fn(async () => undefined),
    removeKey: jest.fn(async () => undefined),
    activate: jest.fn(async () => list),
    deactivate: jest.fn(async () => list),
    test: jest.fn(async () => ({ ok: true, message: 'Key works.' })),
  };
  return { ctl: new AdminProvidersController(credentials as never), credentials, list };
}

describe('AdminProvidersController', () => {
  it('lists providers for a capability', async () => {
    const { ctl, credentials, list } = build();
    await expect(ctl.list(STT)).resolves.toEqual({ success: true, data: list });
    expect(credentials.list).toHaveBeenCalledWith(STT);
  });

  it('rejects a missing capability before touching the service', async () => {
    const { ctl, credentials } = build();
    await expect(ctl.list(undefined)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(credentials.list).not.toHaveBeenCalled();
  });

  it('rejects an unknown provider with 422', async () => {
    const { ctl, credentials } = build();
    await expect(ctl.activate('openai', { capability: STT }, user)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(credentials.activate).not.toHaveBeenCalled();
  });

  it('saves a key as the calling admin and never echoes it', async () => {
    const { ctl, credentials } = build();
    const out = await ctl.setKey('deepgram', { capability: STT, apiKey: 'dg-secret-key-1' }, user);

    expect(credentials.setKey).toHaveBeenCalledWith('deepgram', STT, 'dg-secret-key-1', 'admin-1');
    expect(out).toEqual({ success: true, data: { configured: true } });
  });

  it('removes a key', async () => {
    const { ctl, credentials } = build();
    await expect(ctl.removeKey('elevenlabs', STT, user)).resolves.toEqual({
      success: true,
      data: { configured: false },
    });
    expect(credentials.removeKey).toHaveBeenCalledWith('elevenlabs', STT, 'admin-1');
  });

  it('activates, deactivates and tests', async () => {
    const { ctl, credentials, list } = build();
    await expect(ctl.activate('deepgram', { capability: STT }, user)).resolves.toEqual({ success: true, data: list });
    await expect(ctl.deactivate('deepgram', { capability: STT }, user)).resolves.toEqual({ success: true, data: list });
    await expect(ctl.test('deepgram', { capability: STT })).resolves.toEqual({
      success: true,
      data: { ok: true, message: 'Key works.' },
    });
    expect(credentials.test).toHaveBeenCalledWith('deepgram', STT);
  });
});
```

In `src/core/auth/admin-routes.spec.ts`, import the controller and add it to `ADMIN_CONTROLLERS`:

```ts
import { AdminProvidersController } from '../../modules/admin/admin-providers.controller';
```

```ts
  AdminJobsController,
  AdminProvidersController,
];
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx jest src/core/auth src/modules/providers/provider-params.spec.ts src/modules/admin/admin-providers.controller.spec.ts`
Expected: FAIL. The two new modules cannot be found, and TypeScript rejects `'providers.manage'` as a `Permission`.

- [ ] **Step 3: Add the permission**

In `src/core/auth/permissions.ts`, add `'providers.manage',` after `'admin.manage',` in `PERMISSIONS`. Then change `OWNER` to:

```ts
const OWNER: readonly Permission[] = [
  ...ADMIN,
  'storage.manage',
  'admin.manage',
  'providers.manage',
];
```

- [ ] **Step 4: Write the params helpers and DTOs**

`src/modules/providers/provider-params.ts`:

```ts
import { UnprocessableEntityException } from '@nestjs/common';

import { ProviderCapability, ProviderKind } from '../../generated/prisma/enums';

/**
 * Path and query values erase to plain strings at runtime; without this a
 * typo in `:provider` would reach Prisma and surface as a 500.
 */
function assertOneOf<T extends string>(value: unknown, allowed: Record<string, T>, name: string): T {
  const known = Object.values(allowed);
  if (typeof value === 'string' && (known as string[]).includes(value)) return value as T;
  throw new UnprocessableEntityException(`${name} must be one of: ${known.join(', ')}.`);
}

export function assertProvider(value: unknown): ProviderKind {
  return assertOneOf(value, ProviderKind, 'provider');
}

export function assertCapability(value: unknown): ProviderCapability {
  return assertOneOf(value, ProviderCapability, 'capability');
}
```

`src/modules/providers/dto/capability.dto.ts`:

```ts
import { IsEnum } from 'class-validator';

import { ProviderCapability } from '../../../generated/prisma/enums';

export class CapabilityDto {
  @IsEnum(ProviderCapability)
  capability!: ProviderCapability;
}
```

`src/modules/providers/dto/set-provider-key.dto.ts`:

```ts
import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';

import { CapabilityDto } from './capability.dto';

export class SetProviderKeyDto extends CapabilityDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(8, 512)
  apiKey!: string;
}
```

- [ ] **Step 5: Write the controller and register it**

`src/modules/admin/admin-providers.controller.ts`:

```ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';

import { CurrentUser } from '../../core/auth/current-user.decorator';
import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { RequirePermission } from '../../core/auth/permissions';
import { AccessTokenClaims } from '../auth/token.service';
import { CapabilityDto } from '../providers/dto/capability.dto';
import { SetProviderKeyDto } from '../providers/dto/set-provider-key.dto';
import { ProviderCredentialsService } from '../providers/provider-credentials.service';
import { assertCapability, assertProvider } from '../providers/provider-params';

@Controller('api/admin/v1/providers')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminProvidersController {
  constructor(private readonly credentials: ProviderCredentialsService) {}

  @Get()
  @RequirePermission('providers.manage')
  async list(@Query('capability') capability: string | undefined) {
    return {
      success: true as const,
      data: await this.credentials.list(assertCapability(capability)),
    };
  }

  @Put(':provider/key')
  @RequirePermission('providers.manage')
  async setKey(
    @Param('provider') provider: string,
    @Body() dto: SetProviderKeyDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    await this.credentials.setKey(assertProvider(provider), dto.capability, dto.apiKey, user.sub);
    return { success: true as const, data: { configured: true } };
  }

  @Delete(':provider/key')
  @RequirePermission('providers.manage')
  async removeKey(
    @Param('provider') provider: string,
    @Query('capability') capability: string | undefined,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    await this.credentials.removeKey(
      assertProvider(provider),
      assertCapability(capability),
      user.sub,
    );
    return { success: true as const, data: { configured: false } };
  }

  @Post(':provider/activate')
  @HttpCode(200)
  @RequirePermission('providers.manage')
  async activate(
    @Param('provider') provider: string,
    @Body() dto: CapabilityDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return {
      success: true as const,
      data: await this.credentials.activate(assertProvider(provider), dto.capability, user.sub),
    };
  }

  @Post(':provider/deactivate')
  @HttpCode(200)
  @RequirePermission('providers.manage')
  async deactivate(
    @Param('provider') provider: string,
    @Body() dto: CapabilityDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return {
      success: true as const,
      data: await this.credentials.deactivate(assertProvider(provider), dto.capability, user.sub),
    };
  }

  @Post(':provider/test')
  @HttpCode(200)
  @RequirePermission('providers.manage')
  async test(@Param('provider') provider: string, @Body() dto: CapabilityDto) {
    return {
      success: true as const,
      data: await this.credentials.test(assertProvider(provider), dto.capability),
    };
  }
}
```

In `src/modules/admin/admin.module.ts`:
- Import `ProvidersModule` from `'../providers/providers.module'` and `AdminProvidersController` from `'./admin-providers.controller'`.
- Change `imports` to `[AssetsModule, IngestModule, AuthModule, TaxonomyModule, ProvidersModule]`.
- Append `AdminProvidersController` to `controllers`.

- [ ] **Step 6: Run the tests, lint and typecheck**

Run: `npx jest src/core/auth src/modules/providers src/modules/admin && npm run lint && npm run typecheck`
Expected: PASS. `admin-routes.spec` confirms every handler declares `providers.manage`.

- [ ] **Step 7: Commit**

```bash
git add src/core/auth src/modules/providers src/modules/admin
git commit -m "feat: owner-only admin endpoints for provider keys

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Error codes for captions

**Files:**
- Modify: `src/core/errors/error-codes.ts`, `src/core/errors/http-exception.filter.ts` (`catch` logging branch; `classify` HttpException branch; `codeForStatus`)
- Test: `src/core/errors/error-codes.spec.ts`, `src/core/errors/http-exception.filter.spec.ts`

**Interfaces:**
- Produces:
  - `ErrorCode.CAPTIONS_UNAVAILABLE | PROVIDER_FAILED | PAYLOAD_TOO_LARGE | UNSUPPORTED_MEDIA`.
  - An `HttpException` whose response body is `{ code: <ErrorCode>, message }` keeps that code. Example: `new ServiceUnavailableException({ code: ErrorCode.CAPTIONS_UNAVAILABLE, message })`.
  - 413 maps to `PAYLOAD_TOO_LARGE` and 415 to `UNSUPPORTED_MEDIA`.

- [ ] **Step 1: Write the failing tests**

Add to `src/core/errors/error-codes.spec.ts`, inside the first `it`:

```ts
    expect(ErrorCode.CAPTIONS_UNAVAILABLE).toBe('CAPTIONS_UNAVAILABLE');
    expect(ErrorCode.PROVIDER_FAILED).toBe('PROVIDER_FAILED');
    expect(ErrorCode.PAYLOAD_TOO_LARGE).toBe('PAYLOAD_TOO_LARGE');
    expect(ErrorCode.UNSUPPORTED_MEDIA).toBe('UNSUPPORTED_MEDIA');
```

Add to `src/core/errors/http-exception.filter.spec.ts`. Import `PayloadTooLargeException`, `ServiceUnavailableException` and `UnsupportedMediaTypeException` from `@nestjs/common`. Then add these inside `describe('AllExceptionsFilter', …)`:

```ts
  it('maps multer\'s size error (413) to PAYLOAD_TOO_LARGE', () => {
    const { host, json, status } = hostFor();
    filter.catch(new PayloadTooLargeException('File too large'), host);
    expect(status).toHaveBeenCalledWith(413);
    expect(json.mock.calls[0][0].error.code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
  });

  it('maps 415 to UNSUPPORTED_MEDIA', () => {
    const { host, json, status } = hostFor();
    filter.catch(new UnsupportedMediaTypeException('not audio'), host);
    expect(status).toHaveBeenCalledWith(415);
    expect(json.mock.calls[0][0].error.code).toBe(ErrorCode.UNSUPPORTED_MEDIA);
  });

  it('keeps an explicit error code from the exception body', () => {
    const { host, json, status } = hostFor();
    filter.catch(
      new ServiceUnavailableException({
        code: ErrorCode.CAPTIONS_UNAVAILABLE,
        message: 'Auto caption is not available right now.',
      }),
      host,
    );
    expect(status).toHaveBeenCalledWith(503);
    expect(json.mock.calls[0][0].error).toMatchObject({
      code: ErrorCode.CAPTIONS_UNAVAILABLE,
      message: 'Auto caption is not available right now.',
    });
  });

  it('ignores a body code it does not know', () => {
    const { host, json } = hostFor();
    filter.catch(new BadRequestException({ code: 'MADE_UP', message: 'x' }), host);
    expect(json.mock.calls[0][0].error.code).toBe(ErrorCode.REQUEST_FAILED);
  });

  it('logs a caption outage as one warning, not an error with a stack', () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { host } = hostFor();
    filter.catch(
      new ServiceUnavailableException({ code: ErrorCode.CAPTIONS_UNAVAILABLE, message: 'off' }),
      host,
    );
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    error.mockRestore();
    warn.mockRestore();
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx jest src/core/errors`
Expected: FAIL. The new enum members are undefined, and the new status mappings are wrong.

- [ ] **Step 3: Implement**

In `src/core/errors/error-codes.ts`, add before `REQUEST_FAILED`:

```ts
  CAPTIONS_UNAVAILABLE = 'CAPTIONS_UNAVAILABLE',
  PROVIDER_FAILED = 'PROVIDER_FAILED',
  PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA = 'UNSUPPORTED_MEDIA',
```

In `src/core/errors/http-exception.filter.ts`:

1. Below `firstLine`, add:

```ts
function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (Object.values(ErrorCode) as string[]).includes(value);
}
```

2. In `catch`, change the logging block to:

```ts
    if (code === ErrorCode.DATABASE_UNAVAILABLE) {
      // An outage is not a bug: one line, no stack, so it doesn't drown the log.
      this.logger.error(`${where} database unreachable: ${firstLine(exception)}`);
    } else if (code === ErrorCode.CAPTIONS_UNAVAILABLE) {
      // Expected until the owner makes a provider active; not a server fault.
      this.logger.warn(`${where} auto caption requested but no provider is active`);
    } else if (status >= 500) {
      this.logger.error(where, exception instanceof Error ? exception.stack : String(exception));
    }
```

3. In `classify`, replace the final `return` of the `if (exception instanceof HttpException)` branch:

```ts
      return {
        status,
        code: this.codeForStatus(status),
        message: Array.isArray(raw) ? raw.join(', ') : raw ?? exception.message,
      };
```

with:

```ts
      // A thrower that knows the precise failure says so in the body, e.g.
      // new ServiceUnavailableException({ code: CAPTIONS_UNAVAILABLE, message }).
      const bodyCode =
        typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined;

      return {
        status,
        code: isErrorCode(bodyCode) ? bodyCode : this.codeForStatus(status),
        message: Array.isArray(raw) ? raw.join(', ') : raw ?? exception.message,
      };
```

4. In `codeForStatus`, add before `default:`:

```ts
      case HttpStatus.PAYLOAD_TOO_LARGE:
        return ErrorCode.PAYLOAD_TOO_LARGE;
      case HttpStatus.UNSUPPORTED_MEDIA_TYPE:
        return ErrorCode.UNSUPPORTED_MEDIA;
```

- [ ] **Step 4: Run the tests**

Run: `npx jest src/core/errors && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/errors
git commit -m "feat: error codes for captions; honour an explicit code in exception bodies

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Anonymous devices

**Files:**
- Create: `src/modules/devices/device-token.ts`, `src/modules/devices/devices.service.ts`, `src/modules/devices/device-auth.guard.ts`, `src/modules/devices/current-device.decorator.ts`, `src/modules/devices/dto/register-device.dto.ts`, `src/modules/devices/devices.controller.ts`, `src/modules/devices/devices.module.ts`
- Test: `src/modules/devices/devices.service.spec.ts`, `src/modules/devices/device-auth.guard.spec.ts`
- Modify: `src/app.module.ts` (imports)

**Interfaces:**
- Consumes: `prisma.device` (Task 2).
- Produces:
  - `interface AuthenticatedDevice { id: string }`
  - `DevicesService.register(input: RegisterDeviceDto): Promise<{ deviceId: string; token: string }>`
  - `DevicesService.authenticate(token: string): Promise<AuthenticatedDevice | null>`
  - `DeviceAuthGuard`, which sets `req.device`
  - The `@CurrentDevice()` parameter decorator
  - `DevicesModule`, which exports `DevicesService` and `DeviceAuthGuard`
  - `POST /api/app/v1/devices` → 201 `{ deviceId, token }`

- [ ] **Step 1: Write the failing tests**

`src/modules/devices/devices.service.spec.ts`:

```ts
import { createHash } from 'node:crypto';

import { DevicesService } from './devices.service';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function build(lastSeenAt = new Date()) {
  const devices: Array<{ id: string; tokenHash: string; lastSeenAt: Date }> = [];
  const prisma = {
    device: {
      create: jest.fn(async ({ data }: { data: { tokenHash: string } }) => {
        const row = { id: `dev-${devices.length + 1}`, lastSeenAt, ...data };
        devices.push(row);
        return { id: row.id };
      }),
      findUnique: jest.fn(async ({ where }: { where: { tokenHash: string } }) =>
        devices.find((d) => d.tokenHash === where.tokenHash) ?? null,
      ),
      update: jest.fn(async () => undefined),
    },
  };
  return { svc: new DevicesService(prisma as never), prisma, devices };
}

describe('DevicesService.register', () => {
  it('returns the token once and stores only its SHA-256', async () => {
    const { svc, prisma } = build();
    const { deviceId, token } = await svc.register({ platform: 'android', appVersion: '1.4.0' });

    expect(deviceId).toBe('dev-1');
    expect(token.length).toBeGreaterThanOrEqual(43);
    const data = prisma.device.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).toEqual({ tokenHash: sha256(token), platform: 'android', appVersion: '1.4.0' });
    expect(JSON.stringify(data)).not.toContain(token);
  });

  it('issues a different token every time', async () => {
    const { svc } = build();
    const a = await svc.register({});
    const b = await svc.register({});
    expect(a.token).not.toBe(b.token);
  });
});

describe('DevicesService.authenticate', () => {
  it('finds the device by the hash of its token', async () => {
    const { svc } = build();
    const { token } = await svc.register({});
    await expect(svc.authenticate(token)).resolves.toEqual({ id: 'dev-1' });
  });

  it('returns null for an unknown or empty token', async () => {
    const { svc, prisma } = build();
    await expect(svc.authenticate('nope')).resolves.toBeNull();
    await expect(svc.authenticate('')).resolves.toBeNull();
    expect(prisma.device.findUnique).toHaveBeenCalledTimes(1);
  });

  it('records lastSeenAt at most once a minute', async () => {
    const fresh = build(new Date());
    const t1 = (await fresh.svc.register({})).token;
    await fresh.svc.authenticate(t1);
    expect(fresh.prisma.device.update).not.toHaveBeenCalled();

    const stale = build(new Date(Date.now() - 61_000));
    const t2 = (await stale.svc.register({})).token;
    await stale.svc.authenticate(t2);
    expect(stale.prisma.device.update).toHaveBeenCalledWith({
      where: { id: 'dev-1' },
      data: { lastSeenAt: expect.any(Date) },
    });
  });
});
```

`src/modules/devices/device-auth.guard.spec.ts`:

```ts
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';

import { DeviceAuthGuard } from './device-auth.guard';

function contextWith(headers: Record<string, string>) {
  const req: { headers: Record<string, string>; device?: unknown } = { headers };
  const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
  return { ctx, req };
}

describe('DeviceAuthGuard', () => {
  const devices = { authenticate: jest.fn(async (t: string) => (t === 'good' ? { id: 'dev-1' } : null)) };
  const guard = new DeviceAuthGuard(devices as never);

  it.each([{}, { authorization: 'Basic good' }, { authorization: 'Bearer' }])(
    'rejects %j with 401',
    async (headers) => {
      await expect(guard.canActivate(contextWith(headers).ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    },
  );

  it('rejects an unknown token with 401', async () => {
    await expect(guard.canActivate(contextWith({ authorization: 'Bearer bad' }).ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('attaches the device for a known token', async () => {
    const { ctx, req } = contextWith({ authorization: 'Bearer good' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.device).toEqual({ id: 'dev-1' });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx jest src/modules/devices`
Expected: FAIL with "Cannot find module './devices.service'".

- [ ] **Step 3: Implement**

`src/modules/devices/device-token.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';

/** 256 random bits, URL-safe: the app stores it and sends it as a bearer token. */
export function newDeviceToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What the database keeps: a stolen table cannot be replayed as tokens. */
export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
```

`src/modules/devices/dto/register-device.dto.ts`:

```ts
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class RegisterDeviceDto {
  @IsOptional()
  @IsIn(['android', 'ios', 'web'])
  platform?: 'android' | 'ios' | 'web';

  @IsOptional()
  @IsString()
  @MaxLength(32)
  appVersion?: string;
}
```

`src/modules/devices/devices.service.ts`:

```ts
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { hashDeviceToken, newDeviceToken } from './device-token';
import { RegisterDeviceDto } from './dto/register-device.dto';

export interface AuthenticatedDevice {
  id: string;
}

/** A write per request would be pure churn; a minute is precise enough for "last seen". */
const LAST_SEEN_RESOLUTION_MS = 60_000;

@Injectable()
export class DevicesService {
  constructor(private readonly prisma: PrismaService) {}

  async register(input: RegisterDeviceDto): Promise<{ deviceId: string; token: string }> {
    const token = newDeviceToken();
    const device = await this.prisma.device.create({
      data: {
        tokenHash: hashDeviceToken(token),
        platform: input.platform ?? null,
        appVersion: input.appVersion ?? null,
      },
      select: { id: true },
    });
    return { deviceId: device.id, token };
  }

  async authenticate(token: string): Promise<AuthenticatedDevice | null> {
    if (!token) return null;

    const device = await this.prisma.device.findUnique({
      where: { tokenHash: hashDeviceToken(token) },
      select: { id: true, lastSeenAt: true },
    });
    if (!device) return null;

    if (Date.now() - device.lastSeenAt.getTime() >= LAST_SEEN_RESOLUTION_MS) {
      await this.prisma.device.update({
        where: { id: device.id },
        data: { lastSeenAt: new Date() },
      });
    }
    return { id: device.id };
  }
}
```

`src/modules/devices/device-auth.guard.ts`:

```ts
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

import { AuthenticatedDevice, DevicesService } from './devices.service';

/** App routes only. Admin routes keep JwtAuthGuard; the two never mix. */
@Injectable()
export class DeviceAuthGuard implements CanActivate {
  constructor(private readonly devices: DevicesService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined>; device?: AuthenticatedDevice }>();

    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException('Missing device token.');
    }

    const device = await this.devices.authenticate(token);
    if (!device) {
      throw new UnauthorizedException('Unknown device token. Register the device again.');
    }

    req.device = device;
    return true;
  }
}
```

`src/modules/devices/current-device.decorator.ts`:

```ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import { AuthenticatedDevice } from './devices.service';

export const CurrentDevice = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedDevice =>
    context.switchToHttp().getRequest<{ device: AuthenticatedDevice }>().device,
);
```

`src/modules/devices/devices.controller.ts`:

```ts
import { Body, Controller, Post } from '@nestjs/common';

import { DevicesService } from './devices.service';
import { RegisterDeviceDto } from './dto/register-device.dto';

@Controller('api/app/v1/devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  /** No auth: this is how an install gets its token. */
  @Post()
  async register(@Body() dto: RegisterDeviceDto) {
    return { success: true as const, data: await this.devices.register(dto) };
  }
}
```

`src/modules/devices/devices.module.ts`:

```ts
import { Module } from '@nestjs/common';

import { DeviceAuthGuard } from './device-auth.guard';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';

@Module({
  controllers: [DevicesController],
  providers: [DevicesService, DeviceAuthGuard],
  exports: [DevicesService, DeviceAuthGuard],
})
export class DevicesModule {}
```

In `src/app.module.ts`, import `DevicesModule` from `'./modules/devices/devices.module'` and add it to `imports` after `AdminModule`.

- [ ] **Step 4: Run the tests, lint and typecheck**

Run: `npx jest src/modules/devices && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/devices src/app.module.ts
git commit -m "feat: anonymous app devices with hashed bearer tokens

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Caption jobs: start and status

**Files:**
- Create: `src/modules/captions/captions.constants.ts`, `src/modules/captions/captions.service.ts`
- Test: `src/modules/captions/captions.constants.spec.ts`, `src/modules/captions/captions.service.spec.ts`

**Interfaces:**
- Consumes: `ProviderCredentialsService.getActive` (Task 5); `CaptionResult` (Task 3); `AuthenticatedDevice` (Task 8); `ErrorCode.CAPTIONS_UNAVAILABLE | PROVIDER_FAILED` (Task 7); `captionConfig` (Task 1).
- Produces:
  - `QUEUE_CAPTIONS = 'captions'`, `POLL_AFTER_MS = 1500`, `IDEMPOTENCY_KEY: RegExp`, `CAPTION_JOB_ID: RegExp`
  - `interface CaptionJobData { deviceId: string; filePath: string; mimeType: string; language: string | null }`
  - `captionJobId(deviceId, key): string`
  - `encodeFailure(code, message): string`, `decodeFailure(reason): CaptionFailure`
  - `type CaptionJobView` (queued/processing | completed | failed)
  - `interface UploadedAudio { buffer: Buffer; mimetype: string }`
  - `CaptionsService.start(device, audio, language: string | undefined, idempotencyKey): Promise<CaptionJobView>`
  - `CaptionsService.status(device, jobId): Promise<CaptionJobView>`

- [ ] **Step 1: Write the failing tests**

`src/modules/captions/captions.constants.spec.ts`:

```ts
import { CAPTION_JOB_ID, captionJobId, decodeFailure, encodeFailure } from './captions.constants';

describe('captionJobId', () => {
  it('is stable for one device and key, and matches the public id shape', () => {
    const id = captionJobId('dev-1', 'key-12345678');
    expect(id).toBe(captionJobId('dev-1', 'key-12345678'));
    expect(id).toMatch(CAPTION_JOB_ID);
  });

  it('differs across devices sharing a key', () => {
    expect(captionJobId('dev-1', 'key-12345678')).not.toBe(captionJobId('dev-2', 'key-12345678'));
  });
});

describe('failure encoding', () => {
  it('round-trips a code and message through BullMQ\'s failedReason', () => {
    expect(decodeFailure(encodeFailure('PROVIDER_FAILED' as never, 'Corrupt audio: bad header'))).toEqual({
      code: 'PROVIDER_FAILED',
      message: 'Corrupt audio: bad header',
    });
    expect(decodeFailure(encodeFailure('CAPTIONS_UNAVAILABLE' as never, 'off'))).toEqual({
      code: 'CAPTIONS_UNAVAILABLE',
      message: 'off',
    });
  });

  it('never leaks an unexpected failure reason to the app', () => {
    expect(decodeFailure('TypeError: cannot read x of undefined')).toEqual({
      code: 'PROVIDER_FAILED',
      message: 'The caption provider could not process this audio.',
    });
    expect(decodeFailure(undefined).code).toBe('PROVIDER_FAILED');
  });
});
```

`src/modules/captions/captions.service.spec.ts`:

```ts
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HttpException, NotFoundException } from '@nestjs/common';

import { ErrorCode } from '../../core/errors/error-codes';
import { captionJobId } from './captions.constants';
import { CaptionsService } from './captions.service';

const posixIt = process.platform === 'win32' ? it.skip : it;
const device = { id: 'dev-1' };
const KEY = 'key-12345678';
const RESULT = { provider: 'deepgram', language: 'en', durationSeconds: 1, text: 'Hi.', words: [] };

interface FakeJob {
  id: string;
  data: { deviceId: string; filePath: string };
  state: string;
  returnvalue?: unknown;
  failedReason?: string;
  finishedOn?: number;
  getState: () => Promise<string>;
}

function build({ active = true, ttl = 180 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'captions-'));
  const jobs = new Map<string, FakeJob>();
  const queue = {
    getJob: jest.fn(async (id: string) => jobs.get(id)),
    add: jest.fn(async (_name: string, data: FakeJob['data'], opts: { jobId: string }) => {
      const job: FakeJob = { id: opts.jobId, data, state: 'waiting', getState: async () => job.state };
      jobs.set(opts.jobId, job);
      return job;
    }),
  };
  const credentials = { getActive: jest.fn(async () => (active ? { adapter: {}, apiKey: 'k' } : null)) };
  const cfg = { tmpDir: join(dir, 'audio'), resultTtlSeconds: ttl };
  const svc = new CaptionsService(queue as never, credentials as never, cfg as never);
  return { svc, queue, jobs, cfg, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const audio = (text: string) => ({ buffer: Buffer.from(text), mimetype: 'audio/mp4' });

describe('CaptionsService.start', () => {
  it('refuses with CAPTIONS_UNAVAILABLE when no provider is active, writing nothing', async () => {
    const { svc, queue, cfg, cleanup } = build({ active: false });
    const error = await svc.start(device, audio('a'), undefined, KEY).catch((e: unknown) => e);

    expect((error as HttpException).getStatus()).toBe(503);
    expect((error as HttpException).getResponse()).toMatchObject({ code: ErrorCode.CAPTIONS_UNAVAILABLE });
    expect(queue.add).not.toHaveBeenCalled();
    expect(() => readdirSync(cfg.tmpDir)).toThrow();
    cleanup();
  });

  it('writes the audio and queues a job whose id comes from device and key', async () => {
    const { svc, queue, cfg, cleanup } = build();
    const view = await svc.start(device, audio('first'), 'en', KEY);
    const jobId = captionJobId('dev-1', KEY);

    expect(view).toEqual({ jobId, status: 'queued', pollAfterMs: 1500 });
    const filePath = join(cfg.tmpDir, `${jobId}.audio`);
    expect(readFileSync(filePath, 'utf8')).toBe('first');
    expect(queue.add).toHaveBeenCalledWith(
      'transcribe',
      { deviceId: 'dev-1', filePath, mimeType: 'audio/mp4', language: 'en' },
      {
        jobId,
        attempts: 2,
        backoff: { type: 'fixed', delay: 2_000 },
        removeOnComplete: { age: 180 },
        removeOnFail: { age: 180 },
      },
    );
    cleanup();
  });

  posixIt('keeps the audio private to the server user', async () => {
    const { svc, cfg, cleanup } = build();
    const { jobId } = await svc.start(device, audio('x'), undefined, KEY);
    expect(statSync(join(cfg.tmpDir, `${jobId}.audio`)).mode & 0o777).toBe(0o600);
    expect(statSync(cfg.tmpDir).mode & 0o777).toBe(0o700);
    cleanup();
  });

  it('returns the existing job for a resend and drops the second upload unwritten', async () => {
    const { svc, queue, cfg, cleanup } = build();
    const first = await svc.start(device, audio('first'), undefined, KEY);
    const second = await svc.start(device, audio('second'), undefined, KEY);

    expect(second.jobId).toBe(first.jobId);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(cfg.tmpDir, `${first.jobId}.audio`), 'utf8')).toBe('first');
    cleanup();
  });

  it('removes the audio again if the job cannot be queued', async () => {
    const { svc, queue, cfg, cleanup } = build();
    queue.add.mockRejectedValueOnce(new Error('Redis down'));

    await expect(svc.start(device, audio('x'), undefined, KEY)).rejects.toThrow('Redis down');
    expect(readdirSync(cfg.tmpDir)).toEqual([]);
    cleanup();
  });
});

describe('CaptionsService.status', () => {
  async function started(opts?: { ttl?: number }) {
    const ctx = build(opts);
    const { jobId } = await ctx.svc.start(device, audio('x'), undefined, KEY);
    return { ...ctx, jobId, job: ctx.jobs.get(jobId) as FakeJob };
  }

  it.each([
    ['waiting', 'queued'],
    ['delayed', 'queued'],
    ['prioritized', 'queued'],
    ['active', 'processing'],
  ])('reports a %s job as %s', async (state, status) => {
    const { svc, jobId, job, cleanup } = await started();
    job.state = state;
    await expect(svc.status(device, jobId)).resolves.toEqual({ jobId, status, pollAfterMs: 1500 });
    cleanup();
  });

  it('returns the result of a completed job', async () => {
    const { svc, jobId, job, cleanup } = await started();
    Object.assign(job, { state: 'completed', returnvalue: RESULT, finishedOn: Date.now() });
    await expect(svc.status(device, jobId)).resolves.toEqual({ jobId, status: 'completed', result: RESULT });
    cleanup();
  });

  it('returns the decoded error of a failed job', async () => {
    const { svc, jobId, job, cleanup } = await started();
    Object.assign(job, { state: 'failed', failedReason: 'PROVIDER_FAILED: Corrupt audio', finishedOn: Date.now() });
    await expect(svc.status(device, jobId)).resolves.toEqual({
      jobId,
      status: 'failed',
      error: { code: 'PROVIDER_FAILED', message: 'Corrupt audio' },
    });
    cleanup();
  });

  it('hides another device\'s job', async () => {
    const { svc, jobId, cleanup } = await started();
    await expect(svc.status({ id: 'dev-2' }, jobId)).rejects.toBeInstanceOf(NotFoundException);
    cleanup();
  });

  it('404s a malformed id without asking the queue', async () => {
    const { svc, queue, cleanup } = await started();
    queue.getJob.mockClear();
    await expect(svc.status(device, '../../etc/passwd')).rejects.toBeInstanceOf(NotFoundException);
    expect(queue.getJob).not.toHaveBeenCalled();
    cleanup();
  });

  it('404s a result older than the TTL even if BullMQ has not pruned it yet', async () => {
    const { svc, jobId, job, cleanup } = await started({ ttl: 180 });
    Object.assign(job, { state: 'completed', returnvalue: RESULT, finishedOn: Date.now() - 181_000 });
    await expect(svc.status(device, jobId)).rejects.toBeInstanceOf(NotFoundException);
    cleanup();
  });

  it('404s a job BullMQ no longer knows', async () => {
    const { svc, jobId, job, cleanup } = await started();
    job.state = 'unknown';
    await expect(svc.status(device, jobId)).rejects.toBeInstanceOf(NotFoundException);
    cleanup();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx jest src/modules/captions`
Expected: FAIL with "Cannot find module './captions.constants'".

- [ ] **Step 3: Implement**

`src/modules/captions/captions.constants.ts`:

```ts
import { createHash } from 'node:crypto';

import { ErrorCode } from '../../core/errors/error-codes';
import type { CaptionResult } from '../providers/speech-to-text.provider';

export const QUEUE_CAPTIONS = 'captions';

/** How long the app should wait before polling again. */
export const POLL_AFTER_MS = 1_500;

/** The app sends a UUID; anything this shape is accepted. */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,64}$/;

export const CAPTION_JOB_ID = /^cap_[0-9a-f]{32}$/;

export interface CaptionJobData {
  deviceId: string;
  filePath: string;
  mimeType: string;
  language: string | null;
}

/**
 * Derived, not random: a resend with the same Idempotency-Key lands on the
 * job that already exists instead of paying the provider twice, and the id
 * is scoped to the device that created it. The prefix keeps the id from
 * ever being all digits, which BullMQ refuses as a custom id.
 */
export function captionJobId(deviceId: string, idempotencyKey: string): string {
  const digest = createHash('sha256').update(`${deviceId}:${idempotencyKey}`).digest('hex');
  return `cap_${digest.slice(0, 32)}`;
}

const FAILURE_CODES = [ErrorCode.PROVIDER_FAILED, ErrorCode.CAPTIONS_UNAVAILABLE] as const;
export type CaptionFailureCode = (typeof FAILURE_CODES)[number];

export interface CaptionFailure {
  code: CaptionFailureCode;
  message: string;
}

/** BullMQ keeps only an error's message, so the code travels inside it. */
export function encodeFailure(code: CaptionFailureCode, message: string): string {
  return `${code}: ${message}`;
}

export function decodeFailure(reason: string | undefined): CaptionFailure {
  for (const code of FAILURE_CODES) {
    const prefix = `${code}: `;
    if (reason?.startsWith(prefix)) return { code, message: reason.slice(prefix.length) };
  }
  // Anything else is an internal error message; it stays in the server log.
  return {
    code: ErrorCode.PROVIDER_FAILED,
    message: 'The caption provider could not process this audio.',
  };
}

export type CaptionJobView =
  | { jobId: string; status: 'queued' | 'processing'; pollAfterMs: number }
  | { jobId: string; status: 'completed'; result: CaptionResult }
  | { jobId: string; status: 'failed'; error: CaptionFailure };
```

`src/modules/captions/captions.service.ts`:

```ts
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { InjectQueue } from '@nestjs/bullmq';
import {
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Job, Queue } from 'bullmq';

import { captionConfig, type CaptionConfig } from '../../config';
import { ErrorCode } from '../../core/errors/error-codes';
import { ProviderCapability } from '../../generated/prisma/enums';
import type { AuthenticatedDevice } from '../devices/devices.service';
import { ProviderCredentialsService } from '../providers/provider-credentials.service';
import type { CaptionResult } from '../providers/speech-to-text.provider';
import {
  CAPTION_JOB_ID,
  captionJobId,
  type CaptionJobData,
  type CaptionJobView,
  decodeFailure,
  POLL_AFTER_MS,
  QUEUE_CAPTIONS,
} from './captions.constants';

export interface UploadedAudio {
  buffer: Buffer;
  mimetype: string;
}

type CaptionJob = Job<CaptionJobData, CaptionResult>;

@Injectable()
export class CaptionsService {
  constructor(
    @InjectQueue(QUEUE_CAPTIONS) private readonly queue: Queue<CaptionJobData, CaptionResult>,
    private readonly credentials: ProviderCredentialsService,
    @Inject(captionConfig.KEY) private readonly cfg: CaptionConfig,
  ) {}

  async start(
    device: AuthenticatedDevice,
    audio: UploadedAudio,
    language: string | undefined,
    idempotencyKey: string,
  ): Promise<CaptionJobView> {
    // Credit phase: the balance check belongs here, before anything is written or queued.
    if (!(await this.credentials.getActive(ProviderCapability.speech_to_text))) {
      throw new ServiceUnavailableException({
        code: ErrorCode.CAPTIONS_UNAVAILABLE,
        message: 'Auto caption is not available right now. Try again later.',
      });
    }

    const jobId = captionJobId(device.id, idempotencyKey);
    const existing = await this.queue.getJob(jobId);
    // A resend of an upload the server already has: answer with that job and
    // drop the new bytes without writing them.
    if (existing) return this.view(existing);

    await mkdir(this.cfg.tmpDir, { recursive: true, mode: 0o700 });
    const filePath = join(this.cfg.tmpDir, `${jobId}.audio`);
    await writeFile(filePath, audio.buffer, { mode: 0o600 });

    try {
      await this.queue.add(
        'transcribe',
        { deviceId: device.id, filePath, mimeType: audio.mimetype, language: language ?? null },
        {
          jobId,
          // The retry is for outages only; the worker makes refusals unrecoverable.
          attempts: 2,
          backoff: { type: 'fixed', delay: 2_000 },
          removeOnComplete: { age: this.cfg.resultTtlSeconds },
          removeOnFail: { age: this.cfg.resultTtlSeconds },
        },
      );
    } catch (err) {
      await rm(filePath, { force: true });
      throw err;
    }

    return { jobId, status: 'queued', pollAfterMs: POLL_AFTER_MS };
  }

  async status(device: AuthenticatedDevice, jobId: string): Promise<CaptionJobView> {
    if (!CAPTION_JOB_ID.test(jobId)) throw notFound();

    const job = await this.queue.getJob(jobId);
    if (!job || job.data.deviceId !== device.id) throw notFound();

    // BullMQ prunes finished jobs by age only when a later job finishes. The
    // app is promised a fixed window, so enforce it here.
    if (job.finishedOn && Date.now() - job.finishedOn > this.cfg.resultTtlSeconds * 1_000) {
      throw notFound();
    }

    return this.view(job);
  }

  private async view(job: CaptionJob): Promise<CaptionJobView> {
    const jobId = String(job.id);
    const state = await job.getState();

    switch (state) {
      case 'completed':
        return { jobId, status: 'completed', result: job.returnvalue };
      case 'failed':
        return { jobId, status: 'failed', error: decodeFailure(job.failedReason) };
      case 'active':
        return { jobId, status: 'processing', pollAfterMs: POLL_AFTER_MS };
      case 'unknown':
        throw notFound();
      default:
        return { jobId, status: 'queued', pollAfterMs: POLL_AFTER_MS };
    }
  }
}

function notFound(): NotFoundException {
  return new NotFoundException(
    'No caption job with this id. Finished results expire a few minutes after they are ready.',
  );
}
```

- [ ] **Step 4: Run the tests, lint and typecheck**

Run: `npx jest src/modules/captions && npm run lint && npm run typecheck`
Expected: PASS (the mode test is skipped on Windows).

- [ ] **Step 5: Commit**

```bash
git add src/modules/captions
git commit -m "feat: idempotent caption jobs with device-scoped status

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The caption worker and the sweeper

**Files:**
- Create: `src/modules/captions/caption.worker.ts`, `src/modules/captions/caption-sweeper.ts`
- Test: `src/modules/captions/caption.worker.spec.ts`, `src/modules/captions/caption-sweeper.spec.ts`

**Interfaces:**
- Consumes: `ProviderCredentialsService.getActive` (Task 5); `ProviderError` (Task 3); the constants and `encodeFailure` from `captions.constants` (Task 9); `captionConfig` (Task 1).
- Produces:
  - `CaptionWorker`: `@Processor('captions')`, `process(job): Promise<CaptionResult>`; `onApplicationBootstrap()` applies `CAPTION_CONCURRENCY`.
  - `CaptionSweeper`: `onModuleInit` creates the directory (0700), sweeps, then sweeps every 60 s; `sweep(now?: number): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

`src/modules/captions/caption.worker.spec.ts`:

```ts
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UnrecoverableError } from 'bullmq';

import { ProviderKind } from '../../generated/prisma/enums';
import { ProviderError } from '../providers/provider-error';
import { CaptionWorker } from './caption.worker';

const RESULT = { provider: 'deepgram', language: 'en', durationSeconds: 1, text: 'Hi.', words: [] };

function build(transcribe: jest.Mock | null) {
  const dir = mkdtempSync(join(tmpdir(), 'worker-'));
  const filePath = join(dir, 'cap_x.audio');
  writeFileSync(filePath, 'audio');

  const credentials = {
    getActive: jest.fn(async () =>
      transcribe ? { adapter: { kind: 'deepgram', transcribe }, apiKey: 'dg-key-123' } : null,
    ),
  };
  const worker = new CaptionWorker(credentials as never, { concurrency: 4 } as never);
  const job = (attemptsMade = 0) =>
    ({
      id: 'cap_x',
      data: { deviceId: 'dev-1', filePath, mimeType: 'audio/mp4', language: 'en' },
      attemptsMade,
      opts: { attempts: 2 },
    }) as never;

  return { worker, job, filePath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('CaptionWorker.process', () => {
  it('returns the result and deletes the audio', async () => {
    const transcribe = jest.fn(async () => RESULT);
    const { worker, job, filePath, cleanup } = build(transcribe);

    await expect(worker.process(job())).resolves.toEqual(RESULT);
    expect(transcribe).toHaveBeenCalledWith({ filePath, mimeType: 'audio/mp4', language: 'en' }, 'dg-key-123');
    expect(existsSync(filePath)).toBe(false);
    cleanup();
  });

  it('fails for good on a provider refusal and deletes the audio', async () => {
    const transcribe = jest.fn(async () => {
      throw new ProviderError(ProviderKind.deepgram, 400, 'Corrupt audio');
    });
    const { worker, job, filePath, cleanup } = build(transcribe);

    const error = await worker.process(job()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect((error as Error).message).toBe('PROVIDER_FAILED: Corrupt audio');
    expect(existsSync(filePath)).toBe(false);
    cleanup();
  });

  it('keeps the audio for the retry after a first outage', async () => {
    const transcribe = jest.fn(async () => {
      throw new ProviderError(ProviderKind.deepgram, 503, 'Service unavailable');
    });
    const { worker, job, filePath, cleanup } = build(transcribe);

    const error = await worker.process(job(0)).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect((error as Error).message).toBe('PROVIDER_FAILED: Service unavailable');
    expect(existsSync(filePath)).toBe(true);
    cleanup();
  });

  it('deletes the audio after the last attempt fails, hiding network internals', async () => {
    const transcribe = jest.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const { worker, job, filePath, cleanup } = build(transcribe);

    const error = await worker.process(job(1)).catch((e: unknown) => e);
    expect((error as Error).message).toBe('PROVIDER_FAILED: The caption provider could not be reached.');
    expect(existsSync(filePath)).toBe(false);
    cleanup();
  });

  it('fails for good with CAPTIONS_UNAVAILABLE when no provider is active at run time', async () => {
    const { worker, job, filePath, cleanup } = build(null);

    const error = await worker.process(job()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect((error as Error).message).toMatch(/^CAPTIONS_UNAVAILABLE: /);
    expect(existsSync(filePath)).toBe(false);
    cleanup();
  });
});

describe('CaptionWorker.onApplicationBootstrap', () => {
  it('applies the configured concurrency to the BullMQ worker', () => {
    const { worker, cleanup } = build(jest.fn());
    const bull = { concurrency: 1 };
    (worker as unknown as { _worker: typeof bull })._worker = bull;

    worker.onApplicationBootstrap();
    expect(bull.concurrency).toBe(4);
    cleanup();
  });
});
```

`src/modules/captions/caption-sweeper.spec.ts`:

```ts
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CaptionSweeper } from './caption-sweeper';

const posixIt = process.platform === 'win32' ? it.skip : it;
const NOW = Date.now();
const TTL = 180;

function build(states: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sweeper-'));
  const dir = join(root, 'audio');
  const queue = {
    getJob: jest.fn(async (id: string) => (states[id] ? { getState: async () => states[id] } : undefined)),
    clean: jest.fn(async () => []),
  };
  const sweeper = new CaptionSweeper({ tmpDir: dir, resultTtlSeconds: TTL } as never, queue as never);

  const file = (name: string, ageSeconds: number) => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, 'audio');
    const when = new Date(NOW - ageSeconds * 1_000);
    utimesSync(path, when, when);
    return path;
  };

  return { sweeper, queue, dir, file, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('CaptionSweeper.sweep', () => {
  it('deletes old audio whose job is gone or finished, and keeps young audio', async () => {
    const { sweeper, file, cleanup } = build({ cap_done: 'completed', cap_failed: 'failed' });
    const orphan = file('cap_gone.audio', 600);
    const done = file('cap_done.audio', 600);
    const failed = file('cap_failed.audio', 600);
    const young = file('cap_young.audio', 10);

    await sweeper.sweep(NOW);

    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(done)).toBe(false);
    expect(existsSync(failed)).toBe(false);
    expect(existsSync(young)).toBe(true);
    cleanup();
  });

  it('keeps old audio whose job is still waiting or running', async () => {
    const { sweeper, file, cleanup } = build({ cap_backlog: 'waiting', cap_running: 'active', cap_retry: 'delayed' });
    const paths = ['cap_backlog', 'cap_running', 'cap_retry'].map((id) => file(`${id}.audio`, 600));

    await sweeper.sweep(NOW);

    for (const path of paths) expect(existsSync(path)).toBe(true);
    cleanup();
  });

  it('prunes finished jobs older than the TTL from the queue', async () => {
    const { sweeper, queue, cleanup } = build();
    await sweeper.sweep(NOW);
    expect(queue.clean).toHaveBeenCalledWith(TTL * 1_000, 1_000, 'completed');
    expect(queue.clean).toHaveBeenCalledWith(TTL * 1_000, 1_000, 'failed');
    cleanup();
  });

  it('survives a missing directory and a failing queue', async () => {
    const { sweeper, queue, cleanup } = build();
    queue.clean.mockRejectedValue(new Error('Redis down'));
    await expect(sweeper.sweep(NOW)).resolves.toBeUndefined();
    cleanup();
  });
});

describe('CaptionSweeper lifecycle', () => {
  posixIt('creates the directory private to the server user', async () => {
    const { sweeper, dir, cleanup } = build();
    await sweeper.onModuleInit();
    sweeper.onModuleDestroy();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    cleanup();
  });

  it('creates the directory on boot', async () => {
    const { sweeper, dir, cleanup } = build();
    await sweeper.onModuleInit();
    sweeper.onModuleDestroy();
    expect(existsSync(dir)).toBe(true);
    cleanup();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx jest src/modules/captions/caption.worker.spec.ts src/modules/captions/caption-sweeper.spec.ts`
Expected: FAIL with "Cannot find module './caption.worker'".

- [ ] **Step 3: Implement**

`src/modules/captions/caption.worker.ts`:

```ts
import { rm } from 'node:fs/promises';

import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';

import { captionConfig, type CaptionConfig } from '../../config';
import { ErrorCode } from '../../core/errors/error-codes';
import { ProviderCapability } from '../../generated/prisma/enums';
import { ProviderCredentialsService } from '../providers/provider-credentials.service';
import { ProviderError } from '../providers/provider-error';
import type { CaptionResult } from '../providers/speech-to-text.provider';
import { type CaptionJobData, encodeFailure, QUEUE_CAPTIONS } from './captions.constants';

@Processor(QUEUE_CAPTIONS)
export class CaptionWorker extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(CaptionWorker.name);

  constructor(
    private readonly credentials: ProviderCredentialsService,
    @Inject(captionConfig.KEY) private readonly cfg: CaptionConfig,
  ) {
    super();
  }

  /** @Processor options are static; the concurrency comes from .env, so it is applied once the worker exists. */
  onApplicationBootstrap(): void {
    this.worker.concurrency = this.cfg.concurrency;
  }

  async process(job: Job<CaptionJobData, CaptionResult>): Promise<CaptionResult> {
    const { filePath, mimeType, language } = job.data;
    // The audio goes the moment it cannot be needed again: after an answer,
    // after a failure no retry can fix, or after the last attempt.
    let audioDone = false;

    try {
      // Resolved per job, not per upload: a provider switched or turned off
      // while the job waited applies to it.
      const active = await this.credentials.getActive(ProviderCapability.speech_to_text);
      if (!active) {
        audioDone = true;
        throw new UnrecoverableError(
          encodeFailure(ErrorCode.CAPTIONS_UNAVAILABLE, 'No caption provider is active.'),
        );
      }

      const result = await active.adapter.transcribe(
        { filePath, mimeType, language: language ?? undefined },
        active.apiKey,
      );
      audioDone = true;
      // Credit phase: charge here, keyed by job.id, so a retried job can never pay twice.
      return result;
    } catch (err) {
      if (err instanceof UnrecoverableError) throw err;

      if (err instanceof ProviderError && !err.retryable) {
        audioDone = true;
        this.logger.warn(`Caption job ${job.id} refused by ${err.provider} (${err.status}): ${err.message}`);
        throw new UnrecoverableError(encodeFailure(ErrorCode.PROVIDER_FAILED, err.message));
      }

      const attempt = job.attemptsMade + 1;
      audioDone = attempt >= (job.opts.attempts ?? 1);
      this.logger.warn(
        `Caption job ${job.id} attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new Error(
        encodeFailure(
          ErrorCode.PROVIDER_FAILED,
          err instanceof ProviderError ? err.message : 'The caption provider could not be reached.',
        ),
      );
    } finally {
      if (audioDone) await rm(filePath, { force: true });
    }
  }
}
```

`src/modules/captions/caption-sweeper.ts`:

```ts
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { captionConfig, type CaptionConfig } from '../../config';
import { type CaptionJobData, QUEUE_CAPTIONS } from './captions.constants';

const SWEEP_INTERVAL_MS = 60_000;
const AUDIO_SUFFIX = '.audio';
const FINISHED_STATES = new Set(['completed', 'failed', 'unknown']);

/**
 * The backstop behind the worker's own cleanup. On boot and every minute it
 * deletes temp audio older than CAPTION_RESULT_TTL_SECONDS (left by a crash
 * mid-job), and prunes finished jobs past the same age, which BullMQ would
 * otherwise only prune when another job finishes.
 */
@Injectable()
export class CaptionSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CaptionSweeper.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(captionConfig.KEY) private readonly cfg: CaptionConfig,
    @InjectQueue(QUEUE_CAPTIONS) private readonly queue: Queue<CaptionJobData>,
  ) {}

  async onModuleInit(): Promise<void> {
    // Failing here (bad path, no permission) should stop the boot: uploads would fail anyway.
    await mkdir(this.cfg.tmpDir, { recursive: true, mode: 0o700 });
    await this.sweep();
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(now = Date.now()): Promise<void> {
    const maxAgeMs = this.cfg.resultTtlSeconds * 1_000;
    try {
      await this.sweepFiles(now, maxAgeMs);
      await this.queue.clean(maxAgeMs, 1_000, 'completed');
      await this.queue.clean(maxAgeMs, 1_000, 'failed');
    } catch (err) {
      // A failed sweep (Redis blip, a file in use) must not take the server down; the next one retries.
      this.logger.warn(`Caption sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async sweepFiles(now: number, maxAgeMs: number): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.cfg.tmpDir);
    } catch {
      return;
    }

    for (const name of names) {
      const path = join(this.cfg.tmpDir, name);
      const info = await stat(path).catch(() => null);
      if (!info?.isFile() || now - info.mtimeMs <= maxAgeMs) continue;

      // Old is not enough: a job still waiting behind a long queue needs its audio.
      if (name.endsWith(AUDIO_SUFFIX)) {
        const job = await this.queue.getJob(name.slice(0, -AUDIO_SUFFIX.length));
        if (job && !FINISHED_STATES.has(await job.getState())) continue;
      }

      await rm(path, { force: true });
    }
  }
}
```

- [ ] **Step 4: Run the tests, lint and typecheck**

Run: `npx jest src/modules/captions && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/captions
git commit -m "feat: caption worker that deletes audio as soon as it is done, plus sweeper

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: App caption endpoints, module wiring, HTTP test

**Files:**
- Create: `src/modules/captions/dto/start-caption.dto.ts`, `src/modules/captions/captions.controller.ts`, `src/modules/captions/captions.module.ts`, `src/app.setup.ts`
- Modify: `src/main.ts`, `src/app.module.ts`
- Test: `src/modules/captions/captions.http.spec.ts`

**Interfaces:**
- Consumes: `CaptionsService`, `UploadedAudio`, `IDEMPOTENCY_KEY` (Task 9); `CaptionWorker`, `CaptionSweeper` (Task 10); `DevicesModule`, `DeviceAuthGuard`, `CurrentDevice`, `DevicesController` (Task 8); `ProvidersModule` (Task 5); `captionConfig` (Task 1).
- Produces:
  - `POST /api/app/v1/captions` → 202
  - `GET /api/app/v1/captions/:jobId` → 200
  - `configureHttp(app: INestApplication): void`

- [ ] **Step 1: Write the failing HTTP test**

`src/modules/captions/captions.http.spec.ts`:

```ts
import { INestApplication, ServiceUnavailableException } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';

import { configureHttp } from '../../app.setup';
import { ErrorCode } from '../../core/errors/error-codes';
import { DeviceAuthGuard } from '../devices/device-auth.guard';
import { DevicesController } from '../devices/devices.controller';
import { DevicesService } from '../devices/devices.service';
import { CaptionsController } from './captions.controller';
import { CaptionsService } from './captions.service';

const LIMIT = 1_024;
const QUEUED = { jobId: 'cap_0123456789abcdef0123456789abcdef', status: 'queued', pollAfterMs: 1500 };

describe('app caption API over HTTP', () => {
  let app: INestApplication;
  let base: string;
  const captions = { start: jest.fn(), status: jest.fn() };
  const devices = {
    register: jest.fn(async () => ({ deviceId: 'dev-1', token: 'tok' })),
    authenticate: jest.fn(async (t: string) => (t === 'good-token' ? { id: 'dev-1' } : null)),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MulterModule.register({ limits: { fileSize: LIMIT, files: 1 } })],
      controllers: [CaptionsController, DevicesController],
      providers: [
        { provide: CaptionsService, useValue: captions },
        { provide: DevicesService, useValue: devices },
        DeviceAuthGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    configureHttp(app);
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    captions.start.mockReset().mockResolvedValue(QUEUED);
    captions.status.mockReset().mockResolvedValue(QUEUED);
  });

  function upload(opts: {
    token?: string | null;
    key?: string | null;
    bytes?: number;
    type?: string;
    language?: string;
    withAudio?: boolean;
  } = {}) {
    const form = new FormData();
    if (opts.withAudio !== false) {
      form.append(
        'audio',
        new Blob([new Uint8Array(opts.bytes ?? 16)], { type: opts.type ?? 'audio/mp4' }),
        'clip.m4a',
      );
    }
    if (opts.language !== undefined) form.append('language', opts.language);

    const headers: Record<string, string> = {};
    if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? 'good-token'}`;
    if (opts.key !== null) headers['idempotency-key'] = opts.key ?? 'key-12345678';

    return fetch(`${base}/api/app/v1/captions`, { method: 'POST', headers, body: form });
  }

  async function errorOf(res: Response): Promise<{ code: string; message: string }> {
    const body = (await res.json()) as { success: boolean; error: { code: string; message: string } };
    expect(body.success).toBe(false);
    return body.error;
  }

  it('registers a device', async () => {
    const res = await fetch(`${base}/api/app/v1/devices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'android', appVersion: '1.4.0' }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ success: true, data: { deviceId: 'dev-1', token: 'tok' } });
  });

  it('registers a device with no body at all', async () => {
    const res = await fetch(`${base}/api/app/v1/devices`, { method: 'POST' });
    expect(res.status).toBe(201);
  });

  it('rejects an unknown platform', async () => {
    const res = await fetch(`${base}/api/app/v1/devices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'symbian' }),
    });
    expect(res.status).toBe(422);
  });

  it('starts a caption job: 202 with the job', async () => {
    const res = await upload({ language: 'EN' });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ success: true, data: QUEUED });
    const [device, audio, language, key] = captions.start.mock.calls[0] as [
      unknown,
      { buffer: Buffer; mimetype: string },
      string,
      string,
    ];
    expect(device).toEqual({ id: 'dev-1' });
    expect(audio.mimetype).toBe('audio/mp4');
    expect(audio.buffer).toHaveLength(16);
    expect(language).toBe('en');
    expect(key).toBe('key-12345678');
  });

  it('401s without a device token, before reading the upload', async () => {
    const res = await upload({ token: null });
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe(ErrorCode.UNAUTHENTICATED);
    expect(captions.start).not.toHaveBeenCalled();
  });

  it('401s an unknown device token', async () => {
    const res = await upload({ token: 'stolen' });
    expect(res.status).toBe(401);
  });

  it.each([null, 'short', 'has spaces in it', 'x'.repeat(65)])('422s Idempotency-Key %j', async (key) => {
    const res = await upload({ key });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('422s a request with no audio', async () => {
    const res = await upload({ withAudio: false });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).message).toMatch(/"audio"/);
  });

  it('415s audio sent as application/octet-stream, naming what it received', async () => {
    const res = await upload({ type: 'application/octet-stream' });
    expect(res.status).toBe(415);
    const error = await errorOf(res);
    expect(error.code).toBe(ErrorCode.UNSUPPORTED_MEDIA);
    expect(error.message).toContain('application/octet-stream');
  });

  it('413s audio over the size limit', async () => {
    const res = await upload({ bytes: LIMIT * 2 });
    expect(res.status).toBe(413);
    expect((await errorOf(res)).code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
  });

  it('422s a language that is not a two-letter code', async () => {
    const res = await upload({ language: 'english' });
    expect(res.status).toBe(422);
  });

  it('503s with CAPTIONS_UNAVAILABLE when no provider is active', async () => {
    captions.start.mockRejectedValue(
      new ServiceUnavailableException({ code: ErrorCode.CAPTIONS_UNAVAILABLE, message: 'off' }),
    );
    const res = await upload();
    expect(res.status).toBe(503);
    expect((await errorOf(res)).code).toBe(ErrorCode.CAPTIONS_UNAVAILABLE);
  });

  it('polls a job for the calling device', async () => {
    const res = await fetch(`${base}/api/app/v1/captions/${QUEUED.jobId}`, {
      headers: { authorization: 'Bearer good-token' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: QUEUED });
    expect(captions.status).toHaveBeenCalledWith({ id: 'dev-1' }, QUEUED.jobId);
  });

  it('401s a poll without a token', async () => {
    const res = await fetch(`${base}/api/app/v1/captions/${QUEUED.jobId}`);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx jest src/modules/captions/captions.http.spec.ts`
Expected: FAIL with "Cannot find module '../../app.setup'".

- [ ] **Step 3: Extract the HTTP setup**

`src/app.setup.ts`:

```ts
import { INestApplication, ValidationPipe } from '@nestjs/common';

import { AllExceptionsFilter } from './core/errors/http-exception.filter';

/** The request pipeline every entry point shares: the server itself and HTTP specs. */
export function configureHttp(app: INestApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
}
```

In `src/main.ts`:
- Replace the `app.useGlobalPipes(…)` and `app.useGlobalFilters(…)` calls with `configureHttp(app);`.
- Add `import { configureHttp } from './app.setup';`.
- Drop the now-unused `ValidationPipe` and `AllExceptionsFilter` imports, keeping `Logger`.

- [ ] **Step 4: Write the DTO, controller and module**

`src/modules/captions/dto/start-caption.dto.ts`:

```ts
import { Transform } from 'class-transformer';
import { IsOptional, Matches } from 'class-validator';

export class StartCaptionDto {
  // Multipart text fields arrive as strings; blank means "detect it".
  @Transform(({ value }) =>
    typeof value === 'string' ? (value.trim() === '' ? undefined : value.trim().toLowerCase()) : value,
  )
  @IsOptional()
  @Matches(/^[a-z]{2}$/, { message: 'language must be a two-letter ISO 639-1 code such as en, fr or yo' })
  language?: string;
}
```

`src/modules/captions/captions.controller.ts`:

```ts
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { CurrentDevice } from '../devices/current-device.decorator';
import { DeviceAuthGuard } from '../devices/device-auth.guard';
import type { AuthenticatedDevice } from '../devices/devices.service';
import { IDEMPOTENCY_KEY } from './captions.constants';
import { CaptionsService, type UploadedAudio } from './captions.service';
import { StartCaptionDto } from './dto/start-caption.dto';

// The guard runs before the file interceptor, so an unauthenticated upload is
// refused without its body ever being read.
@Controller('api/app/v1/captions')
@UseGuards(DeviceAuthGuard)
export class CaptionsController {
  constructor(private readonly captions: CaptionsService) {}

  @Post()
  @HttpCode(202)
  @UseInterceptors(FileInterceptor('audio'))
  async start(
    @CurrentDevice() device: AuthenticatedDevice,
    @UploadedFile() audio: UploadedAudio | undefined,
    @Body() dto: StartCaptionDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new UnprocessableEntityException(
        'Send an Idempotency-Key header of 8–64 letters, digits, "-" or "_" (a UUID works).',
      );
    }
    if (!audio) {
      throw new UnprocessableEntityException('Attach the audio as a multipart file field named "audio".');
    }
    if (!audio.mimetype.startsWith('audio/')) {
      throw new UnsupportedMediaTypeException(
        `The audio part must have an audio/* content type; got ${audio.mimetype}.`,
      );
    }

    return {
      success: true as const,
      data: await this.captions.start(device, audio, dto.language, idempotencyKey),
    };
  }

  @Get(':jobId')
  async status(@CurrentDevice() device: AuthenticatedDevice, @Param('jobId') jobId: string) {
    return { success: true as const, data: await this.captions.status(device, jobId) };
  }
}
```

`src/modules/captions/captions.module.ts`:

```ts
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';

import { captionConfig, type CaptionConfig } from '../../config';
import { DevicesModule } from '../devices/devices.module';
import { ProvidersModule } from '../providers/providers.module';
import { CaptionSweeper } from './caption-sweeper';
import { CaptionWorker } from './caption.worker';
import { QUEUE_CAPTIONS } from './captions.constants';
import { CaptionsController } from './captions.controller';
import { CaptionsService } from './captions.service';

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUE_CAPTIONS }),
    // No storage or dest: multer keeps the upload in memory, and the service
    // writes it to CAPTION_TMP_DIR only once the request has passed every check.
    MulterModule.registerAsync({
      inject: [captionConfig.KEY],
      useFactory: (caption: CaptionConfig) => ({
        limits: { fileSize: caption.maxUploadBytes, files: 1 },
      }),
    }),
    DevicesModule,
    ProvidersModule,
  ],
  controllers: [CaptionsController],
  providers: [CaptionsService, CaptionWorker, CaptionSweeper],
})
export class CaptionsModule {}
```

In `src/app.module.ts`, import `CaptionsModule` from `'./modules/captions/captions.module'` and add it to `imports` after `DevicesModule`.

- [ ] **Step 5: Run the whole suite, lint, typecheck and build**

Run: `npx jest && npm run lint && npm run typecheck && npm run build`
Expected: all PASS. The HTTP spec runs a real Nest app on a random local port; it needs no database or Redis.

- [ ] **Step 6: Commit**

```bash
git add src/app.setup.ts src/main.ts src/app.module.ts src/modules/captions
git commit -m "feat: app endpoints to start and poll caption jobs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Developer guide for the mobile developer

**Files:**
- Create: `docs/app-api/auto-caption.md`

**Interfaces:**
- Consumes: the endpoints, shapes and error codes built in Tasks 7–11. The guide must match them exactly.

- [ ] **Step 1: Write the guide**

`docs/app-api/auto-caption.md`:

````markdown
# Auto caption: app API

The app sends the video's audio to the SlimShot server and gets back every spoken word with
its start and end time. The server talks to the speech-to-text provider; the app never does
and never needs to know which provider answered.

- **Base URL:** `https://<server>/api/app/v1` (local: `http://<your-machine-ip>:2700/api/app/v1`)
- **Format:** JSON responses in one envelope:
  - success: `{ "success": true, "data": … }`
  - failure: `{ "success": false, "error": { "code": "…", "message": "…", "traceId": "…" } }`

  Branch on `error.code`, never on `message`. Include `traceId` in bug reports: it matches the
  server log line.

## The flow

1. Once per install: `POST /devices` → keep the `token`.
2. Per caption: extract the audio → `POST /captions` → `202` with a `jobId`.
3. Poll `GET /captions/{jobId}` every `pollAfterMs` until `status` is `completed` or `failed`.
4. Use `result.words` right away. A finished result is deleted after **3 minutes**.

## 1. Register the install: `POST /devices`

No authentication. JSON body, every field optional:

```json
{ "platform": "android", "appVersion": "1.4.0" }
```

`platform` is `android`, `ios` or `web`; `appVersion` is at most 32 characters.

`201`:

```json
{ "success": true, "data": { "deviceId": "cmg…", "token": "Qm9…43 characters…" } }
```

Store `token` in secure storage (`flutter_secure_storage`). It is shown once; the server keeps
only a hash. Send it as `Authorization: Bearer <token>` on every caption call. If a caption
call ever answers `401 UNAUTHENTICATED`, register again, store the new token, and retry once.

## 2. Extract the audio

Send only the audio track, mono, 16 kHz. It keeps uploads small (about 0.5 MB per minute)
and is all speech recognition needs:

```bash
ffmpeg -i input.mp4 -vn -ac 1 -ar 16000 -c:a aac -b:a 64k audio.m4a
```

Word times in the result are seconds from the start of this file. Extract from the start of
the video, or add your own offset. The upload limit is 50 MB by default.

## 3. Start a caption: `POST /captions`

Headers:
- `Authorization: Bearer <token>`
- `Idempotency-Key: <uuid>`: a new UUID per caption attempt, 8–64 characters of letters,
  digits, `-` or `_`.

Body: `multipart/form-data`
- `audio` (file, required). **Its part must carry an `audio/*` content type** (for `.m4a`
  use `audio/mp4`; `.ogg` → `audio/ogg`; `.wav` → `audio/wav`). Flutter's
  `MultipartFile.fromPath` sends `application/octet-stream` unless you pass `contentType`,
  and the server rejects that with 415.
- `language` (text, optional): a two-letter ISO 639-1 code such as `en`, `fr`, `yo`. Omit it
  to let the provider detect the language.

`202`:

```json
{ "success": true, "data": { "jobId": "cap_4f0c…", "status": "queued", "pollAfterMs": 1500 } }
```

**Retrying an upload.** If the upload times out or the connection drops, send it again with
the **same** `Idempotency-Key`. The server recognizes it and answers with the job it already
has, so nothing is transcribed (or paid for) twice. Use a new key only for a new attempt,
for example after a `failed` result.

Errors:

| Status | `error.code` | Meaning | What the app does |
|---|---|---|---|
| 401 | `UNAUTHENTICATED` | missing or unknown device token | register again, retry once |
| 413 | `PAYLOAD_TOO_LARGE` | audio over the size limit | lower the bitrate, or split |
| 415 | `UNSUPPORTED_MEDIA` | the `audio` part is not `audio/*` | set `contentType` |
| 422 | `VALIDATION_FAILED` | no `audio`, bad `Idempotency-Key` or `language` | fix the request |
| 503 | `CAPTIONS_UNAVAILABLE` | Auto caption is switched off on the server | show "Auto caption is unavailable right now" |

## 4. Poll: `GET /captions/{jobId}`

Header: `Authorization: Bearer <token>`. Wait `pollAfterMs` between polls.

Still working (`200`):

```json
{ "success": true, "data": { "jobId": "cap_4f0c…", "status": "processing", "pollAfterMs": 1500 } }
```

`status` is `queued` (waiting its turn) or `processing` (with the provider). Keep polling.

Done (`200`):

```json
{
  "success": true,
  "data": {
    "jobId": "cap_4f0c…",
    "status": "completed",
    "result": {
      "provider": "deepgram",
      "language": "en",
      "durationSeconds": 42.7,
      "text": "Welcome back to the channel. Today we…",
      "words": [
        { "text": "Welcome", "start": 0.08, "end": 0.42, "confidence": 0.99 },
        { "text": "back", "start": 0.42, "end": 0.61, "confidence": 0.98 }
      ]
    }
  }
}
```

- `words` holds spoken words only, in order, with punctuation attached (`"channel."`). No
  spaces and no sound effects.
- `start` and `end` are seconds from the start of the uploaded audio (floats).
- `confidence` is 0–1.
- `language` is the code you sent, or the detected one. Detected codes can be two or three
  letters (`en` or `eng`); treat it as informational.
- `durationSeconds` may be `null`.
- Silence or music gives `completed` with `"text": ""` and `"words": []`. Show "No speech
  found", not an error.

Failed (`200`):

```json
{ "success": true, "data": { "jobId": "cap_4f0c…", "status": "failed", "error": { "code": "PROVIDER_FAILED", "message": "…" } } }
```

`error.code` is `PROVIDER_FAILED` (the provider could not process the audio) or
`CAPTIONS_UNAVAILABLE` (switched off while the job waited). The user can try again; use a
new `Idempotency-Key`.

`404 NOT_FOUND`: unknown job, a job that belongs to another device, or a result older than
3 minutes. Start over with a new `Idempotency-Key`.

Stop polling after about 10 minutes and show a timeout message.

## Dart example

Uses `package:http`, `package:http_parser` and `package:uuid`.

```dart
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart';
import 'package:uuid/uuid.dart';

const base = 'https://api.example.com/api/app/v1';

class CaptionException implements Exception {
  CaptionException(this.code, this.message);
  final String code;
  final String message;
  @override
  String toString() => '$code: $message';
}

Map<String, dynamic> _data(String body) {
  final json = jsonDecode(body) as Map<String, dynamic>;
  if (json['success'] != true) {
    final error = json['error'] as Map<String, dynamic>;
    throw CaptionException(error['code'] as String, error['message'] as String);
  }
  return json['data'] as Map<String, dynamic>;
}

Future<String> registerDevice() async {
  final res = await http.post(
    Uri.parse('$base/devices'),
    headers: {'Content-Type': 'application/json'},
    body: jsonEncode({'platform': 'android', 'appVersion': '1.4.0'}),
  );
  return _data(res.body)['token'] as String; // store it in secure storage
}

/// Returns the `result` object: `text`, `language`, `durationSeconds`, `words`.
Future<Map<String, dynamic>> autoCaption(String token, String audioPath, {String? language}) async {
  // One key per attempt. Reuse the same key if you resend this upload.
  final idempotencyKey = const Uuid().v4();

  final request = http.MultipartRequest('POST', Uri.parse('$base/captions'))
    ..headers['Authorization'] = 'Bearer $token'
    ..headers['Idempotency-Key'] = idempotencyKey
    ..files.add(await http.MultipartFile.fromPath(
      'audio',
      audioPath,
      contentType: MediaType('audio', 'mp4'), // required: the default is octet-stream
    ));
  if (language != null) request.fields['language'] = language;

  final started = await http.Response.fromStream(await request.send());
  var job = _data(started.body);

  final deadline = DateTime.now().add(const Duration(minutes: 10));
  while (job['status'] == 'queued' || job['status'] == 'processing') {
    if (DateTime.now().isAfter(deadline)) {
      throw CaptionException('TIMEOUT', 'Captioning took too long.');
    }
    await Future.delayed(Duration(milliseconds: (job['pollAfterMs'] as int?) ?? 1500));
    final res = await http.get(
      Uri.parse('$base/captions/${job['jobId']}'),
      headers: {'Authorization': 'Bearer $token'},
    );
    job = _data(res.body);
  }

  if (job['status'] == 'failed') {
    final error = job['error'] as Map<String, dynamic>;
    throw CaptionException(error['code'] as String, error['message'] as String);
  }
  return job['result'] as Map<String, dynamic>;
}
```

## curl

```bash
TOKEN=$(curl -s -X POST http://localhost:2700/api/app/v1/devices | jq -r .data.token)

curl -s -X POST http://localhost:2700/api/app/v1/captions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" \
  -F "audio=@audio.m4a;type=audio/mp4" \
  -F "language=en"

curl -s http://localhost:2700/api/app/v1/captions/<jobId> -H "Authorization: Bearer $TOKEN"
```
````

- [ ] **Step 2: Check the guide against the code**

Run:

```bash
for code in UNAUTHENTICATED PAYLOAD_TOO_LARGE UNSUPPORTED_MEDIA VALIDATION_FAILED CAPTIONS_UNAVAILABLE PROVIDER_FAILED NOT_FOUND; do grep -q "$code = '$code'" src/core/errors/error-codes.ts && echo "ok $code" || echo "MISSING $code"; done
grep -n "POLL_AFTER_MS = \|IDEMPOTENCY_KEY = \|Matches(/\^\[a-z\]{2}\$/" src/modules/captions/captions.constants.ts src/modules/captions/dto/start-caption.dto.ts
```

Expected: every code prints `ok`. The poll interval (1 500 ms), the key pattern (8–64 of `A-Za-z0-9_-`) and the two-letter language rule match the guide.

- [ ] **Step 3: Commit**

```bash
git add docs/app-api/auto-caption.md
git commit -m "docs: auto caption app API guide for the mobile developer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Dashboard groundwork: Tabs, profile, providers API

**Precondition:** the dashboard builds on `main` after `feat/overview-redesign` is merged (spec §7). The owner decides that merge. If they approved it:

```bash
git -C "C:/Users/HP/Desktop/Slimshot workspace/slimshot-admin" switch main
git -C "C:/Users/HP/Desktop/Slimshot workspace/slimshot-admin" merge --ff-only feat/overview-redesign
git -C "C:/Users/HP/Desktop/Slimshot workspace/slimshot-admin" switch -c feat/providers-settings
```

If they have not, branch from the overview branch instead: `git -C … switch -c feat/providers-settings feat/overview-redesign`. Either way, nothing below touches the Overview.

**Files (all in `slimshot-admin`):**
- Create: `components/ui/tabs.tsx`
- Modify: `components/ui/primitives.test.tsx` (new `describe('Tabs')`)
- Create: `lib/auth/profile.ts`
- Create: `lib/api/providers.ts`, `lib/api/providers.test.ts`

**Interfaces:**
- Produces:
  - `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`.
  - `fetchMe(): Promise<AdminProfile>`, `useProfile(): UseQueryResult<AdminProfile>`.
  - `type ProviderKind = 'deepgram' | 'elevenlabs'`, `type ProviderCapability = 'speech_to_text'`.
  - `interface ProviderStatus { provider; capability; configured: boolean; active: boolean; updatedAt: string | null }`, `interface KeyCheck { ok: boolean; message: string }`.
  - `PROVIDER_LABELS`, `providersQueryKey(capability)`, `fetchProviders(capability)`, `saveProviderKey(provider, capability, apiKey)`, `removeProviderKey(provider, capability)`, `activateProvider(provider, capability)`, `deactivateProvider(provider, capability)`, `testProviderKey(provider, capability)`.

- [ ] **Step 1: Write the failing tests**

In `components/ui/primitives.test.tsx`, add the import:

```tsx
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';
```

and append:

```tsx
describe('Tabs', () => {
  function renderTabs() {
    return render(
      <Tabs defaultValue="a">
        <TabsList aria-label="Sections">
          <TabsTrigger value="a">Alpha</TabsTrigger>
          <TabsTrigger value="b">Beta</TabsTrigger>
        </TabsList>
        <TabsContent value="a">Alpha panel</TabsContent>
        <TabsContent value="b">Beta panel</TabsContent>
      </Tabs>,
    );
  }

  it('marks the selected tab, shows its panel, and has phone-size targets without shadows', () => {
    renderTabs();
    const alpha = screen.getByRole('tab', { name: 'Alpha' });
    expect(alpha).toHaveAttribute('data-state', 'active');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Alpha panel');
    expect(alpha).toHaveClass('h-11', 'md:h-8');
    expect(screen.getByRole('tablist').className).not.toMatch(/shadow/);
  });

  it('switches panels on click', async () => {
    const user = userEvent.setup();
    renderTabs();
    await user.click(screen.getByRole('tab', { name: 'Beta' }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Beta panel');
  });
});
```

`lib/api/providers.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as client from '@/lib/api/client';
import {
  activateProvider,
  deactivateProvider,
  fetchProviders,
  removeProviderKey,
  saveProviderKey,
  testProviderKey,
} from './providers';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiFetch: vi.fn() };
});
vi.mock('@/lib/auth/session', () => ({ withRefresh: (fn: () => unknown) => fn() }));

afterEach(() => {
  vi.resetAllMocks();
});

describe('providers API', () => {
  it('lists providers for a capability', async () => {
    vi.mocked(client.apiFetch).mockResolvedValue([]);
    await fetchProviders('speech_to_text');
    expect(client.apiFetch).toHaveBeenCalledWith('/providers?capability=speech_to_text');
  });

  it('saves a key with PUT', async () => {
    vi.mocked(client.apiFetch).mockResolvedValue({ configured: true });
    await saveProviderKey('deepgram', 'speech_to_text', 'dg-key-123');
    expect(client.apiFetch).toHaveBeenCalledWith('/providers/deepgram/key', {
      method: 'PUT',
      body: JSON.stringify({ capability: 'speech_to_text', apiKey: 'dg-key-123' }),
    });
  });

  it('removes a key with DELETE and the capability in the query', async () => {
    vi.mocked(client.apiFetch).mockResolvedValue({ configured: false });
    await removeProviderKey('elevenlabs', 'speech_to_text');
    expect(client.apiFetch).toHaveBeenCalledWith('/providers/elevenlabs/key?capability=speech_to_text', {
      method: 'DELETE',
    });
  });

  it.each([
    ['activate', activateProvider],
    ['deactivate', deactivateProvider],
    ['test', testProviderKey],
  ] as const)('posts to %s', async (action, fn) => {
    vi.mocked(client.apiFetch).mockResolvedValue([]);
    await fn('deepgram', 'speech_to_text');
    expect(client.apiFetch).toHaveBeenCalledWith(`/providers/deepgram/${action}`, {
      method: 'POST',
      body: JSON.stringify({ capability: 'speech_to_text' }),
    });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- components/ui/primitives.test.tsx lib/api/providers.test.ts`
Expected: FAIL with "Failed to resolve import './tabs'" and "'./providers'".

- [ ] **Step 3: Implement**

`components/ui/tabs.tsx`:

```tsx
"use client"

import * as React from "react"
import { cn } from "@/lib/cn"
import { Tabs as TabsPrimitive } from "radix-ui"

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col gap-4", className)} {...props} />
}

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn("inline-flex w-fit items-center gap-1 rounded-lg border border-border bg-surface p-1", className)}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        // 44px below md, per the responsive strategy; compact at md+.
        "inline-flex h-11 items-center justify-center rounded-md px-3 text-sm font-medium text-muted md:h-8",
        "transition-colors duration-150 ease-out hover:text-text",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-from)]",
        "disabled:pointer-events-none disabled:opacity-50",
        "data-[state=active]:bg-elevated data-[state=active]:text-text",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn("outline-none", className)} {...props} />
}

export { Tabs, TabsContent, TabsList, TabsTrigger }
```

`lib/auth/profile.ts` (restored from `72c6e09^`, comment updated):

```ts
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api/client';
import { withRefresh } from './session';
import type { AdminProfile } from './session';

export function fetchMe(): Promise<AdminProfile> {
  return withRefresh(() => apiFetch<AdminProfile>('/auth/me'));
}

/**
 * Settings is owner-only, and the role that gates it lives on the profile,
 * not in anything the client already holds, so an owner-only screen needs
 * this before it decides what to render or fetch.
 */
export function useProfile(): UseQueryResult<AdminProfile> {
  return useQuery({ queryKey: ['auth', 'me'], queryFn: fetchMe });
}
```

`lib/api/providers.ts`:

```ts
import { apiFetch } from './client';
import { withRefresh } from '@/lib/auth/session';

/**
 * Wraps the server's owner-only /providers endpoints
 * (slimshot_server/src/modules/admin/admin-providers.controller.ts). No call
 * here ever receives an API key back: the server only says whether one is saved.
 */
export type ProviderKind = 'deepgram' | 'elevenlabs';
export type ProviderCapability = 'speech_to_text';

export interface ProviderStatus {
  provider: ProviderKind;
  capability: ProviderCapability;
  configured: boolean;
  active: boolean;
  updatedAt: string | null;
}

export interface KeyCheck {
  ok: boolean;
  message: string;
}

export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  deepgram: 'Deepgram',
  elevenlabs: 'ElevenLabs',
};

export function providersQueryKey(capability: ProviderCapability) {
  return ['providers', capability] as const;
}

export function fetchProviders(capability: ProviderCapability): Promise<ProviderStatus[]> {
  return withRefresh(() =>
    apiFetch<ProviderStatus[]>(`/providers?capability=${encodeURIComponent(capability)}`),
  );
}

export function saveProviderKey(
  provider: ProviderKind,
  capability: ProviderCapability,
  apiKey: string,
): Promise<{ configured: true }> {
  return withRefresh(() =>
    apiFetch<{ configured: true }>(`/providers/${provider}/key`, {
      method: 'PUT',
      body: JSON.stringify({ capability, apiKey }),
    }),
  );
}

export function removeProviderKey(
  provider: ProviderKind,
  capability: ProviderCapability,
): Promise<{ configured: false }> {
  return withRefresh(() =>
    apiFetch<{ configured: false }>(
      `/providers/${provider}/key?capability=${encodeURIComponent(capability)}`,
      { method: 'DELETE' },
    ),
  );
}

function post<T>(provider: ProviderKind, action: string, capability: ProviderCapability): Promise<T> {
  return withRefresh(() =>
    apiFetch<T>(`/providers/${provider}/${action}`, {
      method: 'POST',
      body: JSON.stringify({ capability }),
    }),
  );
}

export function activateProvider(provider: ProviderKind, capability: ProviderCapability) {
  return post<ProviderStatus[]>(provider, 'activate', capability);
}

export function deactivateProvider(provider: ProviderKind, capability: ProviderCapability) {
  return post<ProviderStatus[]>(provider, 'deactivate', capability);
}

export function testProviderKey(provider: ProviderKind, capability: ProviderCapability) {
  return post<KeyCheck>(provider, 'test', capability);
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- components/ui/primitives.test.tsx lib/api/providers.test.ts && npm run lint`
Expected: PASS. The existing "no UI primitive sets cursor-default" test still passes, since `tabs.tsx` sets no cursor.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/HP/Desktop/Slimshot workspace/slimshot-admin" add components/ui/tabs.tsx components/ui/primitives.test.tsx lib/auth/profile.ts lib/api/providers.ts lib/api/providers.test.ts
git -C "C:/Users/HP/Desktop/Slimshot workspace/slimshot-admin" commit -m "feat: tabs primitive, profile hook and providers API client

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Provider cards and the Providers tab

**Files (in `slimshot-admin`):**
- Create: `components/settings/provider-key-dialog.tsx`, `components/settings/remove-key-dialog.tsx`, `components/settings/provider-card.tsx`, `components/settings/providers-tab.tsx`
- Test: `components/settings/provider-card.test.tsx`, `components/settings/providers-tab.test.tsx`

**Interfaces:**
- Consumes: everything Task 13 produces; `Dialog*`, `Button`, `Input` from `components/ui`; `toast` from `lib/use-toast`; `cn`.
- Produces: `ProviderCard({ status }: { status: ProviderStatus })`, `ProvidersTab()`.

- [ ] **Step 1: Write the failing tests**

`components/settings/provider-card.test.tsx`:

```tsx
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import * as providersApi from '@/lib/api/providers';
import type { ProviderStatus } from '@/lib/api/providers';
import { ProviderCard } from './provider-card';

vi.mock('@/lib/api/providers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/providers')>('@/lib/api/providers');
  return {
    ...actual,
    saveProviderKey: vi.fn(),
    removeProviderKey: vi.fn(),
    activateProvider: vi.fn(),
    deactivateProvider: vi.fn(),
    testProviderKey: vi.fn(),
  };
});

function status(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    provider: 'deepgram',
    capability: 'speech_to_text',
    configured: false,
    active: false,
    updatedAt: null,
    ...overrides,
  };
}

function renderCard(s: ProviderStatus) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<ProviderCard status={s} />, { wrapper: Wrapper });
}

afterEach(() => {
  vi.resetAllMocks();
});

describe('ProviderCard', () => {
  it('without a key: says so, offers Add key, and cannot be tested or made active', () => {
    renderCard(status());
    expect(screen.getByRole('heading', { name: 'Deepgram' })).toBeInTheDocument();
    expect(screen.getByText('No key')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add key' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Test key' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Make active' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Remove key' })).toBeNull();
  });

  it('with a saved key: offers Replace key and Make active', async () => {
    vi.mocked(providersApi.activateProvider).mockResolvedValue([]);
    const user = userEvent.setup();
    renderCard(status({ configured: true, updatedAt: '2026-09-28T10:00:00.000Z' }));

    expect(screen.getByText('Key saved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replace key' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Make active' }));
    expect(providersApi.activateProvider).toHaveBeenCalledWith('deepgram', 'speech_to_text');
  });

  it('when active: shows Active and Turn off', async () => {
    vi.mocked(providersApi.deactivateProvider).mockResolvedValue([]);
    const user = userEvent.setup();
    renderCard(status({ configured: true, active: true }));

    expect(screen.getByText('Active')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Turn off' }));
    expect(providersApi.deactivateProvider).toHaveBeenCalledWith('deepgram', 'speech_to_text');
  });

  it('shows the key test result inline', async () => {
    vi.mocked(providersApi.testProviderKey).mockResolvedValue({
      ok: false,
      message: 'Deepgram rejected this key: Invalid credentials.',
    });
    const user = userEvent.setup();
    renderCard(status({ configured: true }));

    await user.click(screen.getByRole('button', { name: 'Test key' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Deepgram rejected this key: Invalid credentials.');
  });

  it('takes a key in a password field that starts empty and forgets what was typed', async () => {
    vi.mocked(providersApi.saveProviderKey).mockResolvedValue({ configured: true });
    const user = userEvent.setup();
    renderCard(status({ configured: true }));

    await user.click(screen.getByRole('button', { name: 'Replace key' }));
    const input = screen.getByLabelText('API key');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveValue('');

    await user.type(input, 'short');
    expect(screen.getByRole('button', { name: 'Save key' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Replace key' }));
    expect(screen.getByLabelText('API key')).toHaveValue('');

    await user.type(screen.getByLabelText('API key'), '  dg-new-key-123456  ');
    await user.click(screen.getByRole('button', { name: 'Save key' }));
    expect(providersApi.saveProviderKey).toHaveBeenCalledWith('deepgram', 'speech_to_text', 'dg-new-key-123456');
    await waitFor(() => expect(screen.queryByLabelText('API key')).toBeNull());
  });

  it('shows a save error inside the dialog and keeps it open', async () => {
    vi.mocked(providersApi.saveProviderKey).mockRejectedValue(new Error('apiKey must be 8–512 characters.'));
    const user = userEvent.setup();
    renderCard(status());

    await user.click(screen.getByRole('button', { name: 'Add key' }));
    await user.type(screen.getByLabelText('API key'), 'dg-new-key-123456');
    await user.click(screen.getByRole('button', { name: 'Save key' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('apiKey must be 8–512 characters.');
    expect(screen.getByLabelText('API key')).toBeInTheDocument();
  });

  it('removes a key only after confirmation', async () => {
    vi.mocked(providersApi.removeProviderKey).mockResolvedValue({ configured: false });
    const user = userEvent.setup();
    renderCard(status({ configured: true, active: true }));

    await user.click(screen.getByRole('button', { name: 'Remove key' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Auto caption stops working');
    expect(providersApi.removeProviderKey).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Remove key' }));
    expect(providersApi.removeProviderKey).toHaveBeenCalledWith('deepgram', 'speech_to_text');
  });
});
```

`components/settings/providers-tab.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import * as providersApi from '@/lib/api/providers';
import { ProvidersTab } from './providers-tab';

vi.mock('@/lib/api/providers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/providers')>('@/lib/api/providers');
  return { ...actual, fetchProviders: vi.fn() };
});

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<ProvidersTab />, { wrapper: Wrapper });
}

afterEach(() => {
  vi.resetAllMocks();
});

describe('ProvidersTab', () => {
  it('renders the Auto caption section with one card per provider', async () => {
    vi.mocked(providersApi.fetchProviders).mockResolvedValue([
      { provider: 'deepgram', capability: 'speech_to_text', configured: true, active: true, updatedAt: null },
      { provider: 'elevenlabs', capability: 'speech_to_text', configured: false, active: false, updatedAt: null },
    ]);
    renderTab();

    expect(screen.getByRole('heading', { name: 'Auto caption' })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Speech to text with word timings, used by the app's Auto caption tool. Only one provider can be active.",
      ),
    ).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Deepgram' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'ElevenLabs' })).toBeInTheDocument();
    expect(providersApi.fetchProviders).toHaveBeenCalledWith('speech_to_text');
    expect(screen.queryByText(/Auto caption is off/)).toBeNull();
  });

  it('says so when no provider is active', async () => {
    vi.mocked(providersApi.fetchProviders).mockResolvedValue([
      { provider: 'deepgram', capability: 'speech_to_text', configured: false, active: false, updatedAt: null },
      { provider: 'elevenlabs', capability: 'speech_to_text', configured: false, active: false, updatedAt: null },
    ]);
    renderTab();
    expect(await screen.findByText(/Auto caption is off in the app/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- components/settings`
Expected: FAIL with "Failed to resolve import './provider-card'".

- [ ] **Step 3: Implement the dialogs**

`components/settings/provider-key-dialog.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

const MIN_LENGTH = 8;
const MAX_LENGTH = 512;

/**
 * The typed key lives in KeyForm's state, and KeyForm lives inside
 * DialogContent, which unmounts on close. Closing the dialog, saved or not,
 * therefore drops the key: no effect, and nothing to forget to clear.
 */
function KeyForm({
  providerLabel,
  replacing,
  pending,
  error,
  onSave,
  onClose,
}: {
  providerLabel: string;
  replacing: boolean;
  pending: boolean;
  error: string | null;
  onSave: (apiKey: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState('');
  const trimmed = value.trim();
  const valid = trimmed.length >= MIN_LENGTH && trimmed.length <= MAX_LENGTH;

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !pending) onSave(trimmed);
      }}
    >
      <DialogHeader>
        <DialogTitle>{replacing ? `Replace ${providerLabel} key` : `Add ${providerLabel} key`}</DialogTitle>
        <DialogDescription>
          {replacing
            ? 'The new key replaces the saved one. Saved keys are never shown.'
            : 'Paste the API key from your provider dashboard. It is stored encrypted and never shown again.'}
        </DialogDescription>
      </DialogHeader>

      <label className="grid gap-2 text-sm">
        <span className="text-muted">API key</span>
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-invalid={error ? true : undefined}
        />
      </label>

      {error ? (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!valid || pending}>
          {pending ? 'Saving…' : 'Save key'}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function ProviderKeyDialog({
  open,
  onClose,
  ...form
}: {
  open: boolean;
  providerLabel: string;
  replacing: boolean;
  pending: boolean;
  error: string | null;
  onSave: (apiKey: string) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <KeyForm {...form} onClose={onClose} />
      </DialogContent>
    </Dialog>
  );
}
```

`components/settings/remove-key-dialog.tsx`:

```tsx
'use client';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export function RemoveKeyDialog({
  open,
  providerLabel,
  active,
  pending,
  onConfirm,
  onClose,
}: {
  open: boolean;
  providerLabel: string;
  active: boolean;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`Remove the ${providerLabel} key?`}</DialogTitle>
          <DialogDescription>
            {active
              ? `${providerLabel} is the active provider. Auto caption stops working in the app until another provider is made active.`
              : 'You can add a key again at any time.'}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={pending}>
            {pending ? 'Removing…' : 'Remove key'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Implement the card and the tab**

`components/settings/provider-card.tsx`:

```tsx
'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  activateProvider,
  deactivateProvider,
  PROVIDER_LABELS,
  type KeyCheck,
  type ProviderStatus,
  providersQueryKey,
  removeProviderKey,
  saveProviderKey,
  testProviderKey,
} from '@/lib/api/providers';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/use-toast';
import { ProviderKeyDialog } from './provider-key-dialog';
import { RemoveKeyDialog } from './remove-key-dialog';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

function StatePill({ status }: { status: ProviderStatus }) {
  const state = status.active
    ? { label: 'Active', className: 'bg-success/10 text-success border-success/30' }
    : status.configured
      ? { label: 'Key saved', className: 'bg-elevated text-text border-border' }
      : { label: 'No key', className: 'bg-elevated text-subtle border-border' };

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium',
        state.className,
      )}
    >
      {state.label}
    </span>
  );
}

export function ProviderCard({ status }: { status: ProviderStatus }) {
  const queryClient = useQueryClient();
  const { provider, capability } = status;
  const label = PROVIDER_LABELS[provider];

  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [check, setCheck] = useState<KeyCheck | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: providersQueryKey(capability) });

  const saveKey = useMutation({
    mutationFn: (apiKey: string) => saveProviderKey(provider, capability, apiKey),
    onSuccess: () => {
      setKeyDialogOpen(false);
      setCheck(null);
      toast(`${label} key saved.`, 'success');
      return refresh();
    },
  });

  const removeKey = useMutation({
    mutationFn: () => removeProviderKey(provider, capability),
    onSuccess: () => {
      setRemoveOpen(false);
      setCheck(null);
      toast(`${label} key removed.`, 'success');
      return refresh();
    },
    onError: (error) => toast(messageOf(error), 'error'),
  });

  const toggle = useMutation({
    mutationFn: () =>
      status.active ? deactivateProvider(provider, capability) : activateProvider(provider, capability),
    onSuccess: () => {
      toast(status.active ? `${label} turned off.` : `${label} is now the active provider.`, 'success');
      return refresh();
    },
    onError: (error) => toast(messageOf(error), 'error'),
  });

  const testKey = useMutation({
    mutationFn: () => testProviderKey(provider, capability),
    onSuccess: setCheck,
    onError: (error) => setCheck({ ok: false, message: messageOf(error) }),
  });

  return (
    <article
      data-testid={`provider-${provider}`}
      className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 md:p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-text">{label}</h3>
          <p className="mt-1 text-xs text-muted">
            {status.updatedAt
              ? `Key updated ${new Date(status.updatedAt).toLocaleDateString('en-GB', { dateStyle: 'medium' })}`
              : 'No key saved yet'}
          </p>
        </div>
        <StatePill status={status} />
      </div>

      {check ? (
        <p role="status" className={cn('text-sm', check.ok ? 'text-success' : 'text-error')}>
          {check.message}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => { saveKey.reset(); setKeyDialogOpen(true); }}>
          {status.configured ? 'Replace key' : 'Add key'}
        </Button>
        <Button size="sm" onClick={() => testKey.mutate()} disabled={!status.configured || testKey.isPending}>
          {testKey.isPending ? 'Testing…' : 'Test key'}
        </Button>
        <Button size="sm" onClick={() => toggle.mutate()} disabled={!status.configured || toggle.isPending}>
          {status.active ? 'Turn off' : 'Make active'}
        </Button>
        {status.configured ? (
          <Button size="sm" variant="danger" onClick={() => setRemoveOpen(true)}>
            Remove key
          </Button>
        ) : null}
      </div>

      <ProviderKeyDialog
        open={keyDialogOpen}
        providerLabel={label}
        replacing={status.configured}
        pending={saveKey.isPending}
        error={saveKey.error ? messageOf(saveKey.error) : null}
        onSave={(apiKey) => saveKey.mutate(apiKey)}
        onClose={() => setKeyDialogOpen(false)}
      />
      <RemoveKeyDialog
        open={removeOpen}
        providerLabel={label}
        active={status.active}
        pending={removeKey.isPending}
        onConfirm={() => removeKey.mutate()}
        onClose={() => setRemoveOpen(false)}
      />
    </article>
  );
}
```

`components/settings/providers-tab.tsx`:

```tsx
'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchProviders, providersQueryKey } from '@/lib/api/providers';
import { ProviderCard } from './provider-card';

const CAPABILITY = 'speech_to_text' as const;

export function ProvidersTab() {
  const query = useQuery({
    queryKey: providersQueryKey(CAPABILITY),
    queryFn: () => fetchProviders(CAPABILITY),
  });
  const providers = query.data;

  return (
    <section aria-labelledby="auto-caption-heading" className="flex flex-col gap-4">
      <div>
        <h2 id="auto-caption-heading" className="text-base font-semibold text-text">
          Auto caption
        </h2>
        <p className="mt-1 text-sm text-muted">
          Speech to text with word timings, used by the app&apos;s Auto caption tool. Only one provider can be
          active.
        </p>
      </div>

      {query.isLoading ? <p className="text-sm text-subtle">Loading…</p> : null}

      {providers ? (
        <div className="grid gap-3 md:grid-cols-2 md:gap-4">
          {providers.map((status) => (
            <ProviderCard key={status.provider} status={status} />
          ))}
        </div>
      ) : null}

      {providers && !providers.some((p) => p.active) ? (
        <p className="text-sm text-warning">No provider is active, so Auto caption is off in the app.</p>
      ) : null}
    </section>
  );
}
```

- [ ] **Step 5: Run the tests and lint**

Run: `npm test -- components/settings && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git -C "C:/Users/HP/Desktop/Slimshot workspace/slimshot-admin" add components/settings
git -C "C:/Users/HP/Desktop/Slimshot workspace/slimshot-admin" commit -m "feat: provider cards and the Auto caption providers tab

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Settings page and navigation

**Files (in `slimshot-admin`):**
- Create: `app/(dashboard)/settings/page.tsx`, `app/(dashboard)/settings/page.test.tsx`
- Modify: `components/shell/nav-items.ts`, `components/shell/sidebar.tsx`, `components/shell/mobile-top-bar.tsx`
- Test: `components/shell/app-shell.test.tsx`, `components/shell/sidebar.test.tsx`
- Modify: `docs/api-reference.md:197-201`, `docs/START-HERE.md:55`

**Interfaces:**
- Consumes: `useProfile` (Task 13); `ProvidersTab` (Task 14); the `Tabs` primitives (Task 13).
- Produces: route `/settings`; `SETTINGS_ITEM: NavItem`.

- [ ] **Step 1: Write the failing tests**

`app/(dashboard)/settings/page.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { AdminProfile } from '@/lib/auth/session';
import * as apiClient from '@/lib/api/client';
import * as providersApi from '@/lib/api/providers';
import SettingsPage from './page';

// useProfile calls its own module-local fetchMe, which calls apiFetch
// directly, so the profile is stubbed one layer down.
vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiFetch: vi.fn() };
});

vi.mock('@/lib/api/providers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/providers')>('@/lib/api/providers');
  return { ...actual, fetchProviders: vi.fn() };
});

function profile(role: AdminProfile['role']): AdminProfile {
  return { id: '1', email: 'a@b.com', name: 'A', role };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<SettingsPage />, { wrapper: Wrapper });
}

afterEach(() => {
  vi.resetAllMocks();
});

describe('SettingsPage', () => {
  it('tells a non-owner, and never asks for provider data', async () => {
    vi.mocked(apiClient.apiFetch).mockResolvedValue(profile('admin'));
    renderPage();

    expect(await screen.findByText('Only the owner can manage settings.')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 20));
    expect(providersApi.fetchProviders).not.toHaveBeenCalled();
  });

  it('shows the owner the Providers tab with the Auto caption section', async () => {
    vi.mocked(apiClient.apiFetch).mockResolvedValue(profile('owner'));
    vi.mocked(providersApi.fetchProviders).mockResolvedValue([]);
    renderPage();

    expect(await screen.findByRole('tab', { name: 'Providers' })).toHaveAttribute('data-state', 'active');
    expect(screen.getByRole('heading', { name: 'Auto caption' })).toBeInTheDocument();
  });
});
```

In `components/shell/app-shell.test.tsx`, replace the test `'offers the same four destinations on both navs, with no Settings'` with:

```tsx
  it('offers the four peers on both navs, and Settings apart from them', () => {
    render(<AppShell><p>content</p></AppShell>);
    const hrefs = (el: HTMLElement) => [...el.querySelectorAll('a')].map((a) => a.getAttribute('href'));

    expect(hrefs(screen.getByTestId('bottom-nav'))).toEqual(['/', '/assets', '/categories', '/audit']);
    expect(hrefs(screen.getByTestId('sidebar'))).toEqual(['/', '/assets', '/categories', '/audit', '/settings']);
    const bar = screen.getByTestId('mobile-top-bar');
    expect(within(bar).getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
  });
```

Add to `components/shell/sidebar.test.tsx`, inside `describe('Sidebar collapse', …)`:

```tsx
  it('keeps Settings reachable, with its name, when collapsed', async () => {
    const user = userEvent.setup();
    render(<Sidebar />);
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');

    await user.click(screen.getByRole('button', { name: /collapse sidebar/i }));
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- "app/(dashboard)/settings" components/shell`
Expected: FAIL. `./page` does not exist, and no Settings link is found.

- [ ] **Step 3: Add the nav item**

Replace `components/shell/nav-items.ts` with:

```ts
import { FolderTree, LayoutDashboard, Music, ScrollText, Settings, type LucideIcon } from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

// Four peers on both the phone bottom bar and the desktop sidebar.
export const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/assets', label: 'Assets', icon: Music },
  { href: '/categories', label: 'Categories', icon: FolderTree },
  { href: '/audit', label: 'Audit log', icon: ScrollText },
];

// Settings sits apart from the peers: at the foot of the desktop sidebar and
// as a gear in the phone top bar, so the bottom bar keeps its four tabs.
export const SETTINGS_ITEM: NavItem = { href: '/settings', label: 'Settings', icon: Settings };
```

- [ ] **Step 4: Put Settings in the sidebar**

In `components/shell/sidebar.tsx`:

1. Change the nav import to `import { NAV_ITEMS, SETTINGS_ITEM, type NavItem } from './nav-items';`.

2. Add this component below `isTyping`. It is the existing link markup, moved so that Settings can reuse it:

```tsx
function SidebarLink({ item, active, collapsed }: { item: NavItem; active: boolean; collapsed: boolean }) {
  return (
    <RailTooltip label={item.label} show={collapsed}>
      <Link
        href={item.href}
        aria-label={collapsed ? item.label : undefined}
        data-testid={active ? 'nav-active' : undefined}
        className={cn(
          'relative flex items-center gap-3 rounded-lg py-2 text-sm transition-colors duration-150 ease-out',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-from)]',
          collapsed ? 'justify-center px-0' : 'px-3',
          active ? 'bg-elevated text-text' : 'text-muted hover:bg-elevated hover:text-text',
        )}
      >
        {active && (
          <span className={cn('absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full', GRADIENT)} />
        )}
        <item.icon size={18} className="shrink-0" />
        {!collapsed && item.label}
      </Link>
    </RailTooltip>
  );
}
```

3. Replace the whole `<nav className="flex flex-col gap-1">…</nav>` block with:

```tsx
        <nav className="flex flex-col gap-1">
          {NAV_ITEMS.map((item) => (
            <SidebarLink key={item.href} item={item} active={pathname === item.href} collapsed={collapsed} />
          ))}
        </nav>
```

4. Change the footer wrapper `<div className="mt-auto pt-4">` to `<div className="mt-auto flex flex-col gap-1 pt-4">`, and put this as its first child, above the Log out `RailTooltip`:

```tsx
          <SidebarLink item={SETTINGS_ITEM} active={pathname === SETTINGS_ITEM.href} collapsed={collapsed} />
```

- [ ] **Step 5: Put the gear in the phone top bar**

Replace `components/shell/mobile-top-bar.tsx` with:

```tsx
'use client';

import { LogOut } from 'lucide-react';
import Link from 'next/link';
import { performLogout } from './logout-button';
import { SETTINGS_ITEM } from './nav-items';

const GRADIENT = 'bg-[linear-gradient(135deg,var(--brand-from)_0%,var(--brand-to)_100%)]';

const ICON_BUTTON =
  'flex h-11 w-11 items-center justify-center rounded-lg text-muted transition-colors duration-150 ease-out hover:bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-from)]';

/** Phones only: logo, Settings and Log out. The bottom bar holds the four main tabs. */
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
      <div className="flex items-center gap-1">
        <Link href={SETTINGS_ITEM.href} aria-label={SETTINGS_ITEM.label} className={ICON_BUTTON}>
          <SETTINGS_ITEM.icon size={20} />
        </Link>
        <button type="button" onClick={performLogout} aria-label="Log out" className={ICON_BUTTON}>
          <LogOut size={20} />
        </button>
      </div>
    </header>
  );
}
```

- [ ] **Step 6: Write the page**

`app/(dashboard)/settings/page.tsx`:

```tsx
'use client';

import { ProvidersTab } from '@/components/settings/providers-tab';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useProfile } from '@/lib/auth/profile';

export default function SettingsPage() {
  const profile = useProfile();

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold text-text">Settings</h1>

      {profile.isLoading ? (
        <p className="text-sm text-subtle">Loading…</p>
      ) : profile.isError ? (
        <p className="text-sm text-error">Could not load your profile. Reload the page to try again.</p>
      ) : profile.data?.role === 'owner' ? (
        // Owner-only content mounts only here, so a non-owner never fires its queries.
        <Tabs defaultValue="providers">
          <TabsList aria-label="Settings sections">
            <TabsTrigger value="providers">Providers</TabsTrigger>
          </TabsList>
          <TabsContent value="providers">
            <ProvidersTab />
          </TabsContent>
        </Tabs>
      ) : (
        <div className="rounded-xl border border-border bg-surface p-4">
          <p className="text-sm text-text">Only the owner can manage settings.</p>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Update the docs that said Settings was gone**

In `docs/api-reference.md`, replace the `### Settings (removed)` section (the heading and its paragraph) with:

```markdown
### Providers (owner only, permission `providers.manage`)

Provider API keys for Auto caption live in the database, encrypted; everything else stays in
the server's `.env`. No endpoint ever returns a key.

| Method | Path | Body | `data` |
|---|---|---|---|
| GET | `/providers?capability=speech_to_text` | — | `[{ provider, capability, configured, active, updatedAt }]` |
| PUT | `/providers/:provider/key` | `{ capability, apiKey }` | `{ configured: true }` |
| DELETE | `/providers/:provider/key?capability=speech_to_text` | — | `{ configured: false }` |
| POST | `/providers/:provider/activate` | `{ capability }` | the list |
| POST | `/providers/:provider/deactivate` | `{ capability }` | the list |
| POST | `/providers/:provider/test` | `{ capability }` | `{ ok, message }` |

`:provider` is `deepgram` or `elevenlabs` (anything else is 422). Activating without a saved
key is 409. Only one provider per capability is active; activating one turns the other off.
```

In `docs/START-HERE.md`, replace line 55 (`There is no Settings page: server configuration lives in the server's `.env`.`) with:

```markdown
Settings (owner only) has one tab, Providers, where the Auto caption API keys are managed.
All other server configuration lives in the server's `.env`.
```

- [ ] **Step 8: Run everything**

Run: `npm test && npm run lint && npx tsc --noEmit && npm run build`
Expected: all PASS. If `tsc` or the build complains about stale `.next/types` for a deleted route, run `rm -rf .next/types .next/dev/types` in bash and rerun.

- [ ] **Step 9: Commit**

```bash
git -C "C:/Users/HP/Desktop/Slimshot workspace/slimshot-admin" add "app/(dashboard)/settings" components/shell docs/api-reference.md docs/START-HERE.md
git -C "C:/Users/HP/Desktop/Slimshot workspace/slimshot-admin" commit -m "feat: owner-only Settings with a Providers tab

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Final verification

- [ ] **Step 1: Server, clean run**

```bash
cd "C:/Users/HP/Desktop/Slimshot workspace/slimshot_server"
npx jest && npm run lint && npm run typecheck && npm run build
git status --short   # expect nothing uncommitted
```

- [ ] **Step 2: Dashboard, clean run**

```bash
cd "C:/Users/HP/Desktop/Slimshot workspace/slimshot-admin"
npm test && npm run lint && npx tsc --noEmit && npm run build
git status --short
```

- [ ] **Step 3: Confirm no key can leak**

```bash
cd "C:/Users/HP/Desktop/Slimshot workspace/slimshot_server"
grep -rn "apiKeyCipher" src --include=*.ts | grep -v "generated\|\.spec\.ts" 
```

Expected: only `provider-credentials.service.ts`, in `select` clauses and in `decrypt` or `upsert` calls. No controller and no DTO mentions it.

- [ ] **Step 4: Hand over for the owner's smoke test.** These steps are the owner's to run, never the agent's.
  1. Add `MASTER_ENCRYPTION_KEY` to `slimshot_server/.env`: 64 hex characters, generated with the command in `.env.example`.
  2. Run `npx prisma migrate deploy`. It adds two tables and three indexes.
  3. Start the server and dashboard. In Settings → Providers: add a key → Test key → Make active.
  4. With a short `audio.m4a`, run the curl block in `docs/app-api/auto-caption.md`. Expect `202`, then `completed` with words. Expect the file in `CAPTION_TMP_DIR` to be gone.
  5. Give `docs/app-api/auto-caption.md` to the mobile developer.

---

## Self-review notes

- **Spec coverage.**
  - §4 flow → Tasks 9–11.
  - §5 app API → Tasks 8, 9, 11, 12.
  - §6.1 config → Task 1.
  - §6.2 data → Task 2.
  - §6.3 providers → Tasks 3–4.
  - §6.4 credentials → Task 5.
  - §6.5 admin endpoints → Task 6.
  - §6.6 pipeline → Tasks 9–11.
  - §6.7 errors → Task 7.
  - §7 dashboard → Tasks 13–15.
  - §8 rollout → Task 16 step 4.
  - §9 testing → a test step in each task.
  - The credit hooks (§6.6) are comments at the two points, as the spec asks.
- **Names used across tasks.**
  - `captionConfig`/`CaptionConfig`
  - `ProviderCredentialsService.getActive`
  - `ActiveProvider { adapter, apiKey }`
  - `ProviderError.retryable`
  - `encodeFailure`/`decodeFailure`
  - `CaptionJobData`
  - `QUEUE_CAPTIONS`
  - `UploadedAudio`
  - `AuthenticatedDevice`
  - `DeviceAuthGuard`
  - `providersQueryKey`
  - `PROVIDER_LABELS`
  - `SETTINGS_ITEM`
- **Review Focus → tests.**
  1. Octet-stream → Task 11 "415s audio sent as application/octet-stream" and the Task 12 guide.
  2. Silence → Tasks 3 and 4 "returns an empty caption for silence".
  3. Backlog → Task 10 "keeps old audio whose job is still waiting or running".
  4. Stale result → Task 9 "404s a result older than the TTL".
  5. Key rotation → Task 5 "uses a replaced key at once" and "uses a newly activated provider at once".
