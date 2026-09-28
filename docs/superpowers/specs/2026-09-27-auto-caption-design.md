# Auto caption (speech to text) — design

**Date:** 2026-09-27
**Status:** Approved (2026-09-28)
**Repos:** `slimshot_server` (API, this phase) and `slimshot-admin` (Providers tab). The
Flutter app (`slimshotai`) is built afterwards by the mobile developer against the API in §5.

## 1. Purpose

The SlimShot video editor gets an **Auto caption** tool: the user taps it, the app shows a
loading state, and a moment later the video has captions timed word by word. The app never
talks to a speech-to-text provider directly. It talks to our server; our server talks to
whichever provider is active.

This phase builds the server side and the admin controls, and documents the app API so the
mobile developer can build the tool.

## 2. Decisions (made with the owner)

| Question | Decision |
|---|---|
| Providers | Deepgram and ElevenLabs, speech to text only. Text to speech comes later. |
| Where API keys live | Database, encrypted, managed from the dashboard (easy rotation). Everything else stays in `.env`. |
| Active provider | Exactly one provider may be active per capability. |
| App authentication | Anonymous device token for now. User accounts (Google, email) come later. |
| Audio delivery | The app extracts a small mono audio file with FFmpeg and uploads it to our server. |
| Getting the result | Upload returns a job id at once; the app polls until done. A lost connection never re-bills. |
| Queue | BullMQ (already running). It is also where the credit phase will charge. |
| Audio retention | Never stored beyond the job: deleted the moment the provider call finishes. |
| Result retention | 3 minutes, then deleted automatically. |
| Spend limits | None for now (owner is the only tester). A credit system comes in a later phase. |
| Hosting | A single VPS. Temp audio lives on its disk. |

## 3. Out of scope (later phases, owner will call them)

- Credits, prices per caption, ads for credits, payments, premium.
- User accounts (Google sign-in, email), per-user history.
- Text to speech.
- The Flutter tool itself.
- Running on more than one server (would move temp audio to object storage).

## 4. How a caption request flows

```
App                          Server (API)                 BullMQ worker            Provider
 │ POST /devices ─────────────▶ create Device, return token
 │ POST /captions (audio, Idempotency-Key)
 │ ───────────────────────────▶ check token, size, type,
 │                              an active provider exists;
 │                              write temp file (0600);
 │                              add job (id from device+key)
 │ ◀─── 202 { jobId } ────────
 │ GET /captions/:jobId  (every ~1.5 s)
 │ ◀─── 200 { status: queued|processing } …
 │                                                ─▶ read temp file, call active
 │                                                   provider ─────────────────▶ transcribe
 │                                                   ◀──────────── words ─────────┘
 │                                                   delete temp file (always)
 │                                                   store normalized result on the job
 │ GET /captions/:jobId
 │ ◀─── 200 { status: completed, result } (kept 3 min, then removed)
```

**Idempotency.** The app generates an `Idempotency-Key` (a UUID) per caption attempt and
reuses it if it has to resend the upload. The job id is derived from device id + key, so a
resend returns the existing job instead of creating (and paying for) another. The duplicate
upload is discarded without being written.

**Why the job id is derived.** It makes the retry idempotent without a database table, and
it keeps jobs scoped: `GET /captions/:jobId` only answers the device that created it.

## 5. App API (for the mobile developer)

Base path: `/api/app/v1`. Same JSON envelope as the rest of the API:
`{ "success": true, "data": … }` or `{ "success": false, "error": { "code", "message", "traceId" } }`.

### 5.1 `POST /devices` — register an install

No auth. Body (JSON, all optional): `{ "platform": "android" | "ios" | "web", "appVersion": "1.4.0" }`.

`201` → `{ "deviceId": "…", "token": "…" }`

The app stores `token` securely (Android Keystore / flutter_secure_storage) and sends it as
`Authorization: Bearer <token>` on every caption call. The token is shown once; the server
keeps only its SHA-256 hash. A new install registers again.

### 5.2 `POST /captions` — start a caption job

Headers: `Authorization: Bearer <token>`, `Idempotency-Key: <uuid>` (8–64 chars, `A-Z a-z 0-9 - _`).

Body: `multipart/form-data`
- `audio` (file, required): the extracted audio. Recommended: mono, 16 kHz, AAC/M4A or
  Opus/OGG. Any `audio/*` type is accepted.
- `language` (text, optional): ISO 639-1 code such as `en`, `fr`, `yo`. Omit to auto-detect.

`202` → `{ "jobId": "…", "status": "queued", "pollAfterMs": 1500 }`

Errors:

| Status | `error.code` | When |
|---|---|---|
| 422 | `VALIDATION_FAILED` | missing `audio`, bad `Idempotency-Key` or `language` |
| 401 | `UNAUTHENTICATED` | missing or unknown device token |
| 413 | `PAYLOAD_TOO_LARGE` | audio over `CAPTION_MAX_UPLOAD_BYTES` (default 50 MB) |
| 415 | `UNSUPPORTED_MEDIA` | not an `audio/*` file |
| 503 | `CAPTIONS_UNAVAILABLE` | no provider is active (admin has not enabled one) |

### 5.3 `GET /captions/:jobId` — poll

Headers: `Authorization: Bearer <token>`.

`200` while running → `{ "jobId", "status": "queued" | "processing", "pollAfterMs": 1500 }`

`200` when done →
```json
{
  "jobId": "…",
  "status": "completed",
  "result": {
    "provider": "deepgram",
    "language": "en",
    "durationSeconds": 42.7,
    "text": "Welcome back to the channel. Today we…",
    "words": [
      { "text": "Welcome", "start": 0.08, "end": 0.42, "confidence": 0.99 },
      { "text": "back",    "start": 0.42, "end": 0.61, "confidence": 0.98 }
    ]
  }
}
```

`200` when the provider failed → `{ "jobId", "status": "failed", "error": { "code": "PROVIDER_FAILED", "message": "…" } }`
(the app may start a new attempt with a new `Idempotency-Key`).

`404` `NOT_FOUND` → unknown job, a job belonging to another device, or a result older than
3 minutes. The app should fetch the result as soon as it is `completed`.

Times are seconds from the start of the uploaded audio, as floats. `words` holds spoken
words only (no spaces or sound events), with punctuation attached (`"channel."`). `confidence`
is 0–1. The app never needs to know which provider answered.

A developer guide with request examples, a polling loop and a Dart snippet ships as
`docs/app-api/auto-caption.md`.

## 6. Server design

### 6.1 Configuration (`.env`, validated at boot like the rest)

| Variable | Default | Rule |
|---|---|---|
| `MASTER_ENCRYPTION_KEY` | — (required) | exactly 64 hex chars; encrypts provider API keys |
| `CAPTION_TMP_DIR` | `<os tmp>/slimshot-captions` | directory; created with mode 0700 |
| `CAPTION_MAX_UPLOAD_BYTES` | `52428800` (50 MB) | 1 MB – 200 MB |
| `CAPTION_RESULT_TTL_SECONDS` | `180` | 30 – 3600; also the temp-file sweeper age |
| `CAPTION_CONCURRENCY` | `4` | 1 – 20; caption jobs processed at once |
| `CAPTION_DEEPGRAM_MODEL` | `nova-3` | non-empty |
| `CAPTION_ELEVENLABS_MODEL` | `scribe_v2` | non-empty |

New namespaces `cryptoConfig` and `captionConfig`, following `src/config/`.
`MASTER_ENCRYPTION_KEY` returns: `EnvelopeCryptoService` and its spec are restored from git
(commit `3fff7f3^`), now fed by `cryptoConfig` instead of reading `process.env`.

### 6.2 Data (Prisma)

```prisma
enum ProviderKind       { deepgram elevenlabs }
enum ProviderCapability { speech_to_text }

model ProviderCredential {
  id           String             @id @default(cuid())
  provider     ProviderKind
  capability   ProviderCapability
  apiKeyCipher Bytes              // EnvelopeCryptoService output
  keyVersion   Int                @default(1)
  isActive     Boolean            @default(false)
  updatedById  String?
  createdAt    DateTime           @default(now())
  updatedAt    DateTime           @updatedAt

  @@unique([provider, capability])
}

model Device {
  id         String   @id @default(cuid())
  tokenHash  String   @unique            // sha256(token), hex
  platform   String?
  appVersion String?
  createdAt  DateTime @default(now())
  lastSeenAt DateTime @default(now())
  // userId comes with accounts
}
```

The migration also adds a partial unique index so the database itself refuses two active
providers for one capability:
`CREATE UNIQUE INDEX "ProviderCredential_one_active" ON "ProviderCredential"("capability") WHERE "isActive";`

Caption jobs and results are **not** tables: they live in Redis as BullMQ jobs and are
removed 3 minutes after they finish.

### 6.3 Providers (`src/modules/providers/`)

```ts
interface SpeechToTextProvider {
  readonly kind: ProviderKind;
  transcribe(input: { filePath: string; mimeType: string; language?: string }, apiKey: string): Promise<CaptionResult>;
  testKey(apiKey: string): Promise<{ ok: boolean; message: string }>;
}
```

- **Deepgram** (`deepgram.provider.ts`): `POST https://api.deepgram.com/v1/listen?model=<CAPTION_DEEPGRAM_MODEL>&smart_format=true&punctuate=true` plus `language=<code>` or `detect_language=true`; header `Authorization: Token <key>`; body = the audio bytes with its content type. Words from `results.channels[0].alternatives[0].words`, text = `punctuated_word ?? word`; language from `results.channels[0].detected_language` or the requested code; duration from `metadata.duration`. Key test: `GET /v1/projects`.
- **ElevenLabs** (`elevenlabs.provider.ts`): `POST https://api.elevenlabs.io/v1/speech-to-text`, multipart with `model_id=<CAPTION_ELEVENLABS_MODEL>`, `file`, `timestamps_granularity=word`, `tag_audio_events=false`, optional `language_code`; header `xi-api-key`. Keep only `words[].type === "word"`; `confidence = exp(logprob)`; language from `language_code`; duration from `audio_duration_secs`. Key test: `GET /v1/user` (401 = invalid; 403 = valid key without user scope, reported as valid).
- Both use `fetch` with a timeout (10 min), map non-2xx to `ProviderError(status, message)` with the provider's message, and never log the key or audio.
- `ProviderRegistry` maps `ProviderKind` → adapter. Adding a provider is one new adapter plus one enum value.

### 6.4 Credentials service

`ProviderCredentialsService` (owner of `ProviderCredential`):
- `list(capability)` → `{ provider, capability, configured, active, updatedAt }` for every known provider (unconfigured ones included). Never the key.
- `setKey(provider, capability, apiKey, adminId)` → trim, 8–512 chars, encrypt, upsert.
- `removeKey(provider, capability, adminId)` → delete the row (so an active provider becomes inactive).
- `activate(provider, capability, adminId)` → refuses without a key; in one transaction deactivates the others and activates this one.
- `deactivate(provider, capability, adminId)`.
- `test(provider, capability)` → decrypts and calls the adapter's `testKey`.
- `getActive(capability)` → `{ adapter, apiKey }` or `null`; used by the caption worker. Decrypted keys are cached in memory for 60 s and the cache is dropped on any change.
- Every change writes an audit entry (`provider.key.set`, `provider.key.removed`, `provider.activated`, `provider.deactivated`) with the provider and capability, never the key.

### 6.5 Admin endpoints

Under `/api/admin/v1/providers`, permission **`providers.manage`** (new, owner only):

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/?capability=speech_to_text` | — | list |
| PUT | `/:provider/key` | `{ capability, apiKey }` | `{ configured: true }` |
| DELETE | `/:provider/key?capability=…` | — | `{ configured: false }` |
| POST | `/:provider/activate` | `{ capability }` | list |
| POST | `/:provider/deactivate` | `{ capability }` | list |
| POST | `/:provider/test` | `{ capability }` | `{ ok, message }` |

`:provider` is validated against `ProviderKind` (422 otherwise). Activating without a key is a
409 with a plain message.

### 6.6 App endpoints and caption pipeline (`src/modules/captions/`)

- `DevicesController` (`POST /api/app/v1/devices`) and `DevicesService` (create; `authenticate(token)` → device or null; updates `lastSeenAt` at most once a minute).
- `DeviceAuthGuard` reads the bearer token and attaches the device. App routes use it; admin routes are untouched.
- `CaptionsController`: `POST /api/app/v1/captions` with Nest's `FileInterceptor('audio')` using **memory storage** limited to `CAPTION_MAX_UPLOAD_BYTES`; `GET /api/app/v1/captions/:jobId`.
- `CaptionsService.start(device, file, language, idempotencyKey)`:
  1. 503 if no active provider;
  2. `jobId = sha256(deviceId + ":" + idempotencyKey)` (hex, 32 chars);
  3. if that job already exists, return it (the new upload is discarded);
  4. write the buffer to `CAPTION_TMP_DIR/<jobId>.audio` with mode 0600;
  5. add the job to queue `captions` with data `{ deviceId, filePath, mimeType, language }`, `jobId`, `attempts: 2` (the second only for network errors and provider 5xx), `removeOnComplete` / `removeOnFail` `{ age: CAPTION_RESULT_TTL_SECONDS }`.
- `CaptionsService.status(device, jobId)` → 404 unless the job exists and `job.data.deviceId === device.id`; maps BullMQ states: waiting/delayed → `queued`, active → `processing`, completed → `completed` + `returnvalue`, failed → `failed` + error.
- `CaptionWorker` (`@Processor('captions')`, concurrency `CAPTION_CONCURRENCY`): resolves the active provider **when the job runs**, calls `transcribe`, returns the normalized result. The temp file is deleted in `finally` after a success, after an unrecoverable error (provider 4xx → BullMQ `UnrecoverableError`), or after the last attempt. No provider active at run time fails the job with `CAPTIONS_UNAVAILABLE`.
- `TempAudioSweeper`: on boot and every 60 s, deletes files in `CAPTION_TMP_DIR` older than `CAPTION_RESULT_TTL_SECONDS` (a backstop for crashes mid-job).

The credit phase hooks in at two points, both already isolated: a balance check in
`CaptionsService.start` and a charge when `CaptionWorker` completes, keyed by `jobId` so a
retry cannot double-charge.

### 6.7 Errors

New `ErrorCode` values: `CAPTIONS_UNAVAILABLE` (503), `PROVIDER_FAILED` (in job results),
`PAYLOAD_TOO_LARGE` (413), `UNSUPPORTED_MEDIA` (415). Multer's size error maps to 413.

## 7. Dashboard design (`slimshot-admin`)

Builds on `main` after the pending Overview redesign branch is merged.

- **Settings returns**: route `/settings`, owner only (non-owners see "Only the owner can
  manage settings."). Desktop sidebar gets a **Settings** entry; phones reach it from a gear
  button in the top bar next to Log out (the bottom bar keeps its four tabs).
- **Tabs** (Radix Tabs via shadcn, restyled to the tokens). One tab for now: **Providers**.
- **Providers tab → "Auto caption"** section, subtitle: "Speech to text with word timings,
  used by the app's Auto caption tool. Only one provider can be active."
  One card per provider (Deepgram, ElevenLabs) showing:
  - status: *Active* / *Key saved* / *No key*;
  - **Add key** / **Replace key** → dialog with a password-type input and Save (the key is
    never shown again; the field is cleared on close);
  - **Test key** → inline result ("Key works" / the provider's message);
  - **Make active** (disabled without a key) or **Turn off**;
  - **Remove key** → confirmation dialog.
  Mutations use `useMutation`; the list query is invalidated after each.
- `lib/api/providers.ts` wraps the admin endpoints.

## 8. Rollout

1. Put `MASTER_ENCRYPTION_KEY` back in `.env` (the saved copy works; a new one is fine too,
   since nothing encrypted exists yet).
2. Deploy the server; run `npx prisma migrate deploy` (adds two tables and one index).
3. In the dashboard: Settings → Providers → add a key → Test → Make active.
4. Hand `docs/app-api/auto-caption.md` to the mobile developer.

## 9. Testing

- Config: new variables' defaults and ranges; `MASTER_ENCRYPTION_KEY` required.
- Adapters: request shape (URL, headers, body fields) and response normalization for both
  providers against recorded fixtures (fetch mocked); spaces/audio events dropped; errors
  mapped with the provider's message; key never in error text.
- Credentials: encrypt/decrypt round trip; one active per capability; activate without a
  key refused; remove deactivates; list never contains the key; audit entries have no key.
- Devices: token returned once, only its hash stored; guard accepts/rejects.
- Captions: idempotent start (same key → same job, no second file); 503 with no provider;
  413/415; status scoped to the device (other device → 404); state mapping; worker deletes
  the temp file on success, on unrecoverable failure and after the last attempt; sweeper
  deletes only old files.
- Dashboard: Providers tab renders both cards and states; Make active disabled without a
  key; key dialog never displays a stored key; owner gate.
