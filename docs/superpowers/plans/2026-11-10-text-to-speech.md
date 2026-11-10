# Text to speech — server and dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The server turns texts into voice clips with xAI, priced in credits by characters and refunded on failure, with a voices list the owner curates; the dashboard prices it, holds its key and curates the voices.

**Architecture:** Server: a second provider capability (`text_to_speech`) with an xAI adapter beside the speech-to-text one; a `per_characters` pricing mode; a `Voice` table with samples in object storage; a BullMQ `speech` queue shaped like `captions` (idempotent job id, charge before, refund on failure, files on local disk swept after an hour); a public voices list and signed-in speech endpoints. Dashboard: a feature switch on Pricing, a capability switch on Providers, and a Voices page.

**Tech Stack:** NestJS 11, Prisma 7, BullMQ, Jest 30 (server); Next.js 16, TanStack Query 5, shadcn/Radix, Vitest (dashboard).

**Spec:** `slimshotai/docs/superpowers/specs/2026-11-10-text-to-speech-design.md` (in the app repo, beside this workspace's other projects).

Repos: server tasks S1–S9 in `slimshot_server`, dashboard tasks D1–D4 in `slimshot-admin`, each on a new branch `feat/text-to-speech` from `main`; W1 in the website (`slimshotAI_web`, not a git repository — an edit the owner deploys). The app's own plan is written after S9, from the API documents S9 produces.

## Global Constraints

- Auto captions do not change in behaviour: every existing caption, credits and providers test passes unchanged except where a task says so.
- Migration is additive only, written by hand; never run `migrate`, `db push` or `seed` against Neon.
- A character is a Unicode code point of the trimmed text (`[...text.trim()].length`); a request's characters are the sum over its items.
- Limits (config, these defaults): `TTS_MAX_ITEM_CHARACTERS` 2000, `TTS_MAX_REQUEST_CHARACTERS` 20000, `TTS_MAX_ITEMS` 100, `TTS_KEEP_MINUTES` 60, `TTS_CONCURRENCY` 2, `TTS_TMP_DIR` default `<os tmp>/slimshot-speech`.
- xAI: `POST https://api.x.ai/v1/tts` JSON `{ text, voice_id, language: "auto", output_format: { codec: "mp3", sample_rate: 24000, bit_rate: 128000 } }`; voices from `GET https://api.x.ai/v1/tts/voices`; key probe as the speech-to-text adapter's (`GET /v1/api-key`).
- Pricing modes: `text_to_speech` accepts `per_job` and `per_characters`; `auto_captions` keeps `per_job`, `duration_tiers`, `per_second`. `per_characters`: credits per **started** block of `blockCharacters` (1–100000), never below `minCredits`.
- Errors (house shape `appError`): `TTS_UNAVAILABLE` 503, `VOICE_NOT_FOUND` 404, `TEXT_TOO_LONG` 413, plus the existing `INSUFFICIENT_CREDITS` 402, `IDEMPOTENCY_KEY_REUSED` 409, `VALIDATION_FAILED` 422.
- Speech job id `tts_` + 32 hex chars of `sha256("<userId>:<idempotencyKey>")`; item ids match `^[A-Za-z0-9_-]{1,64}$`, unique within a request.
- Voice samples: MP3 under `slimshot/voices/samples/<uuid>.mp3` in the default storage, said by the sentence `Hi! This is how I sound in your video.`; a voice cannot be switched on without a sample.
- Voices and samples are managed under the existing `providers.manage` permission.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No push, no deploy.
- Dashboard: read the relevant guide in `node_modules/next/dist/docs/` before writing any Next.js code (its `AGENTS.md`).

## Review Focus

1. A resend with an Idempotency-Key whose job has finished and been swept must not run on the old charge → `IDEMPOTENCY_KEY_REUSED`, as captions → test in S8 ("a key whose charge is already spent is refused").
2. Emoji and accents are counted alike by app and server: `"héllo 👍🏽"` is 8 code points → test in S2 ("counts code points, not UTF-16 units") and S8 ("a request's characters are the code points of its trimmed texts").
3. The provider switched off, or the voice switched off, between the app's quote and its `POST`: refused there (`TTS_UNAVAILABLE` / `VOICE_NOT_FOUND`), nothing charged. The provider switched off while the job waits in the queue: the job fails **and refunds** (the worker re-reads the provider, as captions' does; a voice switched off after its job was accepted is still spoken — the job carries the provider's voice id) → tests in S8.
4. Another user's job, an item id not in the job, or files already swept → 404, never someone else's audio → test in S8.
5. Sync from xAI when a voice is already known (no duplicate, its label and order kept) or no longer listed (kept, not deleted, so a project's voice choice never vanishes mid-session) → test in S6.

---

### S1: Data — capability, feature, mode, voices (additive migration)

**Files:**
- Modify: `prisma/schema.prisma` (enums `ProviderCapability`, `CreditFeature`, `PricingMode`; model `PricingRule`; new model `Voice`)
- Create: `prisma/migrations/20261110120000_text_to_speech/migration.sql`
- Regenerate: `src/generated/prisma/**` (`npx prisma generate`)

**Interfaces:**
- Produces: `ProviderCapability.text_to_speech`, `CreditFeature.text_to_speech`, `PricingMode.per_characters`, `PricingRule.blockCharacters: Int?`, and

```prisma
model Voice {
  id               String       @id @default(cuid())
  provider         ProviderKind
  providerVoiceId  String
  label            String
  sortOrder        Int          @default(0)
  enabled          Boolean      @default(false)
  sampleStorageId  String?
  sampleStorageKey String?
  sampleUrl        String?
  createdAt        DateTime     @default(now())
  updatedAt        DateTime     @updatedAt

  @@unique([provider, providerVoiceId])
  @@map("voices")
}
```

- [ ] **Step 1:** Edit the schema as above (the enum values appended, never reordered).
- [ ] **Step 2:** Write the migration by hand: `ALTER TYPE "ProviderCapability" ADD VALUE 'text_to_speech';`, the same for `CreditFeature` and `PricingMode` (`'per_characters'`), `ALTER TABLE "PricingRule" ADD COLUMN "blockCharacters" INTEGER;`, and `CREATE TABLE "voices" (...)` with the unique index `voices_provider_providerVoiceId_key`. Match the table and type names the existing migrations use (read the latest one first).
- [ ] **Step 3:** Run `npx prisma validate` then `npx prisma generate`. Expected: both succeed.
- [ ] **Step 4:** Run `npm run typecheck`. Expected: PASS (nothing reads the new values yet).
- [ ] **Step 5:** Commit: `feat(tts): text to speech in the data — a capability, a feature, a per-characters price, voices`.

### S2: Priced by characters

**Files:**
- Modify: `src/modules/credits/pricing.ts`, `src/modules/credits/pricing.service.ts`, `src/modules/admin/dto/credit-admin.dto.ts`, `src/core/errors/error-codes.ts`
- Test: `src/modules/credits/pricing.spec.ts`, `src/modules/credits/pricing.service.spec.ts`

**Interfaces:**
- Produces: `countCharacters(text: string): number` (in `pricing.ts`); `priceFor(rule, amount)` where `amount` is seconds for the duration modes and characters for `per_characters`; `characterBlockProblems(rate)`; `FEATURE_MODES: Record<CreditFeature, PricingMode[]>`; `PricingService.price(feature, amount)` throwing `TTS_UNAVAILABLE` (503, "Text to speech is not available right now. Try again later.") for `text_to_speech` without an active rule, `CAPTIONS_UNAVAILABLE` for captions as now; `ErrorCode.TTS_UNAVAILABLE`, `VOICE_NOT_FOUND`, `TEXT_TOO_LONG`.

- [ ] **Step 1: Write the failing tests**

```ts
// pricing.spec.ts
it('per_characters charges per started block, at least the minimum', () => {
  const rule = { id: 'r', version: 1, mode: 'per_characters', perJobCredits: null, tiers: null,
    blockCharacters: 200, blockCredits: 1, minCredits: 2 } as PricedRule;
  expect(priceFor(rule, 1)).toBe(2);     // one block, raised to the minimum
  expect(priceFor(rule, 200)).toBe(2);
  expect(priceFor(rule, 401)).toBe(3);   // three started blocks
});
it('counts code points, not UTF-16 units', () => {
  expect(countCharacters('  héllo 👍🏽  ')).toBe(8);
});
it('a per-characters rate needs a block of 1–100000 characters', () => {
  expect(characterBlockProblems({ blockCharacters: 0, blockCredits: 1 })).not.toEqual([]);
  expect(characterBlockProblems({ blockCharacters: 200, blockCredits: 1, minCredits: 0 })).toEqual([]);
});
// pricing.service.spec.ts
it('text to speech is priced per job or per characters only', ...)   // per_second and duration_tiers → 422 VALIDATION_FAILED
it('captions refuse a per-characters rule', ...)                       // 422
it('text to speech without a live rule is unavailable', ...)          // price('text_to_speech', 10) → 503 TTS_UNAVAILABLE
```

- [ ] **Step 2:** Run `npx jest src/modules/credits/pricing`. Expected: FAIL (no `per_characters` branch, no `countCharacters`).
- [ ] **Step 3:** Implement: the `per_characters` branch (`blocks = max(1, ceil(amount / blockCharacters))`, no millisecond rounding); `countCharacters`; `characterBlockProblems` (as `blockProblems`, in characters); `ruleProblems` refuses a mode not in `FEATURE_MODES[feature]` ("Text to speech is priced per job or per characters."); `createRule` stores `blockCharacters`; `activeRule` returns it; `price` picks the unavailable error by feature. The DTO gains `@IsOptional() @IsInt() @Min(1) @Max(100_000) blockCharacters?: number`.
- [ ] **Step 4:** Run `npx jest src/modules/credits` and `npx jest src/modules/admin/admin-pricing-rules`. Expected: PASS, existing tests unchanged.
- [ ] **Step 5:** Commit: `feat(tts): a per-characters price, text to speech's own`.

### S3: Quote by characters

**Files:**
- Modify: `src/modules/credits/dto/credits.dto.ts`, `src/modules/credits/credits.controller.ts`, `src/modules/credits/credits.service.ts`
- Test: `src/modules/credits/credits.service.spec.ts`, the credits HTTP spec beside it (create `credits.http.spec.ts` if none covers `quote`)

**Interfaces:**
- Consumes: `PricingService.price(feature, amount)` (S2).
- Produces: `POST /api/app/v1/credits/quote` accepting `{ feature: "text_to_speech", characters: N }` (int 1–20000) beside `{ feature: "auto_captions", durationSeconds }`; `CreditsService.quote(userId, feature, amount)`.

- [ ] **Step 1: Write the failing tests:** `"quotes text to speech by characters"` → `{ credits, balance, enough, pricingVersion }` with `price` called `('text_to_speech', 420)`; `"text to speech needs characters"` → 422 for `{ feature: "text_to_speech" }`; `"captions still need a duration"` → 422 for `{ feature: "auto_captions", characters: 5 }`.
- [ ] **Step 2:** Run the two specs. Expected: FAIL.
- [ ] **Step 3:** `QuoteDto`: `durationSeconds` under `@ValidateIf(o => o.feature === 'auto_captions')`, `characters` under `@ValidateIf(o => o.feature === 'text_to_speech') @IsInt() @Min(1) @Max(20_000)`; the controller passes the feature's amount.
- [ ] **Step 4:** Run `npx jest src/modules/credits`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(tts): quote a voice by its characters`.

### S4: The xAI text-to-speech adapter

**Files:**
- Create: `src/modules/providers/text-to-speech.provider.ts`, `src/modules/providers/xai-tts.provider.ts`
- Modify: `src/modules/providers/provider-http.ts` (`requestAudio`), `src/modules/providers/provider.registry.ts`, `src/modules/providers/providers.module.ts`
- Test: `src/modules/providers/xai-tts.provider.spec.ts`, `src/modules/providers/provider.registry.spec.ts`

**Interfaces:**
- Produces:

```ts
export interface ProviderVoice { providerVoiceId: string; name: string | null; }
export interface TextToSpeechProvider {
  readonly kind: ProviderKind;
  synthesize(input: { text: string; voiceId: string }, apiKey: string): Promise<Buffer>; // MP3
  listVoices(apiKey: string): Promise<ProviderVoice[]>;
  testKey(apiKey: string): Promise<KeyCheck>;
}
export const CAPABLE_PROVIDERS: Record<ProviderCapability, ProviderKind[]>; // speech_to_text: all three; text_to_speech: [xai]
// ProviderRegistry
textToSpeechFor(kind: ProviderKind): TextToSpeechProvider;  // throws for a kind without one
// provider-http.ts
requestAudio(provider, url, init, apiKey, timeoutMs = SYNTHESIZE_TIMEOUT_MS /* 2 min */): Promise<Buffer>;
```

- [ ] **Step 1: Read xAI's REST reference for `GET /v1/tts/voices`** (docs.x.ai › API reference › voice) and record its response shape in the ledger; the parser in Step 4 reads exactly that shape. If it lists a display name, use it as `name`; else `null`.
- [ ] **Step 2: Write the failing tests** with `fetch` mocked: `"sends the text, the voice, auto language and MP3 at 24 kHz / 128 kbps"` (asserts URL, `authorization: Bearer k`, and the exact JSON body from Global Constraints); `"returns the MP3 bytes"`; `"a 4xx is a ProviderError with the key scrubbed"`; `"lists voices"` (from a fixture of the recorded shape); `"text to speech has an adapter for xAI only"` (registry: `textToSpeechFor('deepgram')` throws, and every kind in `CAPABLE_PROVIDERS.text_to_speech` resolves).
- [ ] **Step 3:** Run `npx jest src/modules/providers`. Expected: FAIL.
- [ ] **Step 4:** Implement `requestAudio` (as `requestJson`, reading `arrayBuffer()`; a non-2xx reads the error body as JSON for `providerMessage`); `XaiTextToSpeechProvider` (`testKey` as `XaiProvider`'s, with `keyRefusal`); register it.
- [ ] **Step 5:** Run `npx jest src/modules/providers`. Expected: PASS.
- [ ] **Step 6:** Commit: `feat(tts): an xAI text-to-speech adapter`.

### S5: Keys and providers for both capabilities

**Files:**
- Modify: `src/modules/providers/provider-credentials.service.ts`
- Test: `src/modules/providers/provider-credentials.service.spec.ts`, `src/modules/admin/admin-providers.controller.spec.ts`

**Interfaces:**
- Consumes: `CAPABLE_PROVIDERS`, `textToSpeechFor` (S4).
- Produces: `list(capability)` lists only `CAPABLE_PROVIDERS[capability]`; `setKey`/`activate` refuse a provider that cannot do the capability (422 "Deepgram cannot do text to speech."); `test(provider, capability)` uses that capability's adapter; `getActiveTextToSpeech(): Promise<{ adapter: TextToSpeechProvider; apiKey: string } | null>` (shares the per-capability cache; `getActive` stays speech to text's).

- [ ] **Step 1: Write the failing tests:** `"text to speech lists xAI only"`; `"a key for a provider that cannot speak is refused"`; `"testing a text-to-speech key asks the text-to-speech adapter"`; `"the active voice provider is its own"` (an active `xai` speech-to-text row does not make text to speech active).
- [ ] **Step 2:** Run `npx jest src/modules/providers/provider-credentials src/modules/admin/admin-providers`. Expected: FAIL.
- [ ] **Step 3:** Implement as the Interfaces block says.
- [ ] **Step 4:** Run `npx jest src/modules/providers src/modules/admin src/modules/captions`. Expected: PASS (captions unchanged).
- [ ] **Step 5:** Commit: `feat(tts): a key and an active provider for text to speech`.

### S6: Voices — the curated list, its samples, the dashboard's API

**Files:**
- Create: `src/modules/voices/voices.service.ts`, `src/modules/voices/voices.module.ts`, `src/modules/admin/admin-voices.controller.ts`, `src/modules/admin/dto/voice-admin.dto.ts`
- Modify: `src/modules/admin/admin.module.ts`, `src/modules/admin/audit-labels.ts`, `src/app.module.ts`
- Test: `src/modules/voices/voices.service.spec.ts`, `src/modules/admin/admin-voices.http.spec.ts`

**Interfaces:**
- Consumes: `getActiveTextToSpeech()` (S5); `StorageRegistry.getDefault()` → `putObject`, `getDeliveryUrl`, `delete`.
- Produces: `VoicesService` with `listForApp(): Promise<AppVoice[]>` (`{ id, label, sampleUrl }`, enabled and sampled, by `sortOrder` then `label`); `listForAdmin()`; `sync(adminId)` (adds unknown voices disabled, label = `name ?? providerVoiceId`, `sortOrder` after the last; returns the list); `update(id, { label?, enabled? }, adminId)`; `reorder(ids, adminId)`; `makeSample(id, adminId)`; `voiceForJob(id): Promise<Voice | null>` (enabled only). Admin routes under `api/admin/v1/voices`: `GET /`, `POST /sync`, `PATCH /:id`, `PUT /order`, `POST /:id/sample`, all `@RequirePermission('providers.manage')`.

- [ ] **Step 1: Write the failing tests:** `"sync adds new voices switched off, keeps known ones as they are"` (label and order of an existing row untouched; a voice xAI no longer lists stays); `"a voice cannot be switched on without a sample"` (409 CONFLICT); `"making a sample stores an MP3 of the sample sentence and drops the old one"` (adapter called with `Hi! This is how I sound in your video.`; `putObject` key starts `slimshot/voices/samples/`; old key deleted, a failed delete only logged); `"reordering must name every voice exactly once"` (unknown or duplicate id → 422, nothing changed); `"the app sees only enabled voices with a sample, in order"`; `"sync without an active text-to-speech key says so"` (503 TTS_UNAVAILABLE); HTTP spec: each route's permission and shape.
- [ ] **Step 2:** Run `npx jest src/modules/voices src/modules/admin/admin-voices`. Expected: FAIL.
- [ ] **Step 3:** Implement; each change audit-logged (`voice.synced`, `voice.updated`, `voice.reordered`, `voice.sample.made`) with labels in `audit-labels.ts`.
- [ ] **Step 4:** Run `npx jest src/modules/voices src/modules/admin`. Expected: PASS (`audit-labels.spec` included).
- [ ] **Step 5:** Commit: `feat(tts): voices the owner syncs, samples, switches on and orders`.

### S7: The app's voices list

**Files:**
- Create: `src/modules/voices/voices.controller.ts`
- Test: `src/modules/voices/voices.http.spec.ts`

**Interfaces:**
- Consumes: `VoicesService.listForApp()` (S6).
- Produces: `GET /api/app/v1/voices` — public, rate-limited per IP with the catalogue's `RateLimiter` and limits — `{ success: true, data: AppVoice[] }`.

- [ ] **Step 1: Write the failing tests:** `"lists the voices without sign-in"`; `"too many requests from one address are refused"` (the catalogue's 429 shape).
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx jest src/modules/voices`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(tts): the app's list of voices`.

### S8: Speech jobs — charge, generate, download, refund, sweep

**Files:**
- Create: `src/config/speech.config.ts`; `src/modules/speech/speech.constants.ts`, `speech.service.ts`, `speech.worker.ts`, `speech-sweeper.ts`, `speech.controller.ts`, `speech.module.ts`, `dto/start-speech.dto.ts`; `src/modules/credits/feature-refunds.ts`
- Modify: `src/config/env.validation.ts`, `src/config/index.ts`, `src/app.module.ts`, `src/modules/captions/*` (use `FeatureRefunds`), `.env.example`
- Delete: `src/modules/captions/caption-refunds.ts` and its spec (moved, see Step 3)
- Test: `src/modules/speech/speech.service.spec.ts`, `speech.worker.spec.ts`, `speech-sweeper.spec.ts`, `speech.http.spec.ts`; `src/modules/credits/feature-refunds.spec.ts` (the caption refunds spec, moved)

**Interfaces:**
- Consumes: `countCharacters`, `PricingService.price` (S2); `getActiveTextToSpeech` (S5); `VoicesService.voiceForJob` (S6); `LedgerService.post`.
- Produces:

```ts
// speech.constants.ts
export const QUEUE_SPEECH = 'speech';
export const SPEECH_JOB_ID = /^tts_[0-9a-f]{32}$/;
export const ITEM_ID = /^[A-Za-z0-9_-]{1,64}$/;
export function speechJobId(userId: string, idempotencyKey: string): string;
export interface SpeechJobData { userId: string; voiceId: string; providerVoiceId: string; items: { id: string; text: string }[]; credits: number; }
export type SpeechJobView =
  | { jobId: string; status: 'queued' | 'processing'; pollAfterMs: number }
  | { jobId: string; status: 'completed'; items: { id: string }[] }
  | { jobId: string; status: 'failed'; error: { code: 'PROVIDER_FAILED' | 'TTS_UNAVAILABLE'; message: string } };
// speech.service.ts
start(user, { voiceId, items }, idempotencyKey): Promise<SpeechJobView & { charged?: { credits: number; balance: number } }>;
status(user, jobId): Promise<SpeechJobView>;
audioPath(user, jobId, itemId): Promise<string>;   // the file to stream
// routes: POST /api/app/v1/speech (202), GET /api/app/v1/speech/:jobId, GET /api/app/v1/speech/:jobId/items/:itemId (audio/mpeg)
// feature-refunds.ts
FeatureRefunds.refund(userId, jobId, credits, reason): Promise<void>;  // CaptionRefunds, renamed, never throws
```

- [ ] **Step 1: Write the failing tests** (service, with fakes as `captions.service.spec` builds them):
  - `"a request's characters are the code points of its trimmed texts"` → `price` called with `('text_to_speech', 13)` for items `" hello "`, `"héllo 👍🏽"`.
  - `"refuses an empty text, a text over 2000 characters (413 TEXT_TOO_LONG), more than 100 items, more than 20000 characters, a duplicate or ill-formed item id"` (422 unless named).
  - `"refuses a voice that is unknown or switched off"` → 404 `VOICE_NOT_FOUND`; `"refuses when no voice provider is active"` → 503 `TTS_UNAVAILABLE`.
  - `"charges before queueing and returns the charge"`; `"the same key answers with the same job, no second charge"`; `"a key whose charge is already spent is refused"` → 409 `IDEMPOTENCY_KEY_REUSED`; `"a queue failure refunds"`.
  - `"another user's job, an unknown item and a swept file are 404"`.
  - Worker: `"writes one MP3 per item under its job"` (`<tmpDir>/<jobId>/<itemId>.mp3`, mode 0600); `"any item failing fails the job and refunds it all"`; `"a provider switched off while queued fails and refunds"` (unrecoverable, `TTS_UNAVAILABLE`); `"a refusal is not retried; an outage is, once"`.
  - Sweeper: `"deletes a job's files once it is TTS_KEEP_MINUTES old"`; `"leaves what is not a speech job's"`.
  - HTTP: `"POST needs an Idempotency-Key"` (422), `"signed out is 401"`, `"the audio is served as audio/mpeg"`.
- [ ] **Step 2:** Run `npx jest src/modules/speech src/modules/credits/feature-refunds`. Expected: FAIL.
- [ ] **Step 3:** Move `CaptionRefunds` to `credits/feature-refunds.ts` as `FeatureRefunds` (log text "feature job"), export it from the ledger's module, and switch the captions module to it; its spec moves unchanged but for names.
- [ ] **Step 4:** Implement config (`speechConfig`: the Global Constraints' six settings, validated like the caption ones), constants, service (checks in the order of the tests: items, voice, provider, then price, charge, write, queue — as `CaptionsService.start`), worker (`process` synthesises items in order, writes each file, deletes the job's directory and refunds if it fails for good — `CaptionWorker`'s retry rules), sweeper (`CaptionSweeper`'s shape over job directories, by `finishedOn` + keep minutes), controller (`StreamableFile` with `content-type: audio/mpeg`), module, `.env.example` lines.
- [ ] **Step 5:** Run `npx jest src/modules/speech src/modules/credits src/modules/captions`. Expected: PASS.
- [ ] **Step 6:** Commit: `feat(tts): speech jobs — charged, generated, downloaded, refunded, swept`.

### S9: The contracts, and a full check

**Files:**
- Create: `docs/app-api/text-to-speech.md`, `docs/admin-voices-api.md`
- Modify: `docs/app-credits-api.md` (§11 quote by characters; error table rows), `docs/admin-credits-api.md` (`per_characters`, `blockCharacters`, features' modes)

- [ ] **Step 1:** Write `docs/app-api/text-to-speech.md` in `auto-caption.md`'s shape: voices list, quote, start (body, limits, Idempotency-Key rules — same key same job, a spent key 409, a fresh key only after a `failed` job), poll, download (files kept 60 minutes), every error code with what the app should say, and the counting rule for characters.
- [ ] **Step 2:** Write `docs/admin-voices-api.md` (each route, body, answer, refusals) and the two credit docs' changes.
- [ ] **Step 3:** Run `npm run typecheck`, `npm run lint`, `npx jest`. Expected: all PASS; record counts in the ledger.
- [ ] **Step 4:** Commit: `docs(tts): the app's and the dashboard's contracts`.

### D1: The dashboard's types and API calls

**Files:**
- Modify: `lib/api/credits.ts` (`CreditFeature` adds `'text_to_speech'`, `PricingMode` adds `'per_characters'`, rules carry `blockCharacters`), `lib/api/providers.ts` (`ProviderCapability` adds `'text_to_speech'`)
- Create: `lib/api/voices.ts` (`fetchVoices`, `syncVoices`, `updateVoice`, `reorderVoices`, `makeVoiceSample`, `voicesQueryKey`)
- Test: `lib/api/voices.test.ts`

- [ ] **Step 1:** Read the Next.js and data-fetching guides in `node_modules/next/dist/docs/` that `lib/api/*` relies on.
- [ ] **Step 2: Write the failing tests:** each call hits the S6 route with its method and body (`apiFetch` mocked as the existing API tests mock it).
- [ ] **Step 3:** Run `npx vitest run lib/api/voices`. Expected: FAIL.
- [ ] **Step 4:** Implement from `docs/admin-voices-api.md`.
- [ ] **Step 5:** Run `npm test` and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 6:** Commit: `feat(tts): the dashboard's voice and pricing types`.

### D2: Pricing — a switch between Auto captions and Text to speech

**Files:**
- Modify: `components/credits/pricing-page.tsx`, `components/credits/make-live-dialog.tsx`, `components/settings/pricing-format.ts`
- Test: their `*.test.tsx` / `.test.ts` beside them

- [ ] **Step 1: Write the failing tests:** `"switches between Auto captions and Text to speech, each with its own versions"` (the query key carries the feature); `"text to speech offers per job and per characters only"`; `"describes a per-characters rule as '1 credit per 200 characters, at least 2'"` (`pricing-format`).
- [ ] **Step 2:** Run `npx vitest run components/credits components/settings/pricing-format`. Expected: FAIL.
- [ ] **Step 3:** Implement; the switch is the dashboard's existing tab/segmented control.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(tts): price text to speech on its own`.

### D3: Providers — a switch between Speech to text and Text to speech

**Files:**
- Modify: `components/settings/providers-tab.tsx`
- Test: `app/(dashboard)/system/providers/page.test.tsx` (or the tab's own test)

- [ ] **Step 1: Write the failing tests:** `"switches capability and lists what the server returns for it"` (Text to speech shows xAI only, from the mocked `fetchProviders('text_to_speech')`); `"saving a key sends the shown capability"`.
- [ ] **Step 2:** Run the test. Expected: FAIL.
- [ ] **Step 3:** Replace the `CAPABILITY` constant with a switch-driven state.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(tts): a key for text to speech`.

### D4: The Voices page

**Files:**
- Create: `app/(dashboard)/voices/page.tsx`, `components/voices/voices-page.tsx`, `components/voices/voice-row.tsx`
- Modify: `components/shell/nav-items.ts` (Voices, after Fonts)
- Test: `components/voices/voices-page.test.tsx`

- [ ] **Step 1: Write the failing tests:** `"lists voices with label, sample and switch"`; `"the switch is off and disabled without a sample"`; `"Make sample plays the new one"` (calls `makeVoiceSample`, then the row's player has the new URL); `"renaming saves on blur"`; `"dragging reorders and saves the full order"`; `"Sync from xAI adds the new voices"`; `"without a text-to-speech key, Sync says to add one on Providers"` (the 503's message).
- [ ] **Step 2:** Run `npx vitest run components/voices`. Expected: FAIL.
- [ ] **Step 3:** Implement with the Fonts › Order page's drag-to-order pattern and the existing table, switch and audio-player components.
- [ ] **Step 4:** Run `npm test`, `npm run lint`, `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(tts): Voices — sync, sample, switch on, order`.

### W1: The privacy policy says what a voice sends

**Files:**
- Modify: `slimshotAI_web/slimshot/app/privacy/page.tsx`

The policy says Auto captions is "the one feature that sends media". With voices, the text a user voices goes to SlimShot's server and to xAI, and the audio is kept for an hour. The house rule: anything new that sends data off the phone is in the policy (and in Play Console's Data safety form, the owner's step).

- [ ] **Step 1:** In the overview list, Auto captions stops being "the one feature": two features send something — Auto captions (the sound) and Text to speech (the text you choose to voice). The account line names both as features that use credits.
- [ ] **Step 2:** Add a section after "3. Auto captions", numbered on, in its style: what is sent (the text of the texts you voice, and the voice you chose), who processes it (our server, and xAI as the text-to-speech provider, under its own terms), how long it is kept (the generated audio is kept on our server for up to an hour so the App can download it, then deleted; the text is not kept), and "Please don't voice text you don't have the right to use." Renumber the sections after it, and every in-page reference to them ("see section 3").
- [ ] **Step 3:** The Internet permission line and the lawful-basis paragraph name Text to speech beside Auto captions.
- [ ] **Step 4:** Run `npm run lint` and `npx tsc --noEmit` in `slimshotAI_web/slimshot`. Expected: PASS. No commit (not a repository): tell the owner the page changed and that the Data safety form needs the same.
