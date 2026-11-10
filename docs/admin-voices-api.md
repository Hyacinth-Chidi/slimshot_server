# SlimShot admin API: voices and the text-to-speech provider

The routes the admin dashboard uses for text to speech: the provider key on the Providers page,
and the Voices page (which voices the app offers, their names, order and samples). The price is
on the Pricing page: [`admin-credits-api.md`](admin-credits-api.md) §2, feature `text_to_speech`.
The app's side is [`app-api/text-to-speech.md`](app-api/text-to-speech.md).

## Basics

- **Base URL:** `https://<server>/api/admin/v1`.
- **Auth:** the dashboard's admin access token, `Authorization: Bearer <token>`.
- **Envelope:** `{ "success": true, "data": … }` or
  `{ "success": false, "error": { "code", "message", "details"?, "traceId" } }`. Branch on `code`.
- **Permission:** every route here needs `providers.manage` (the owner). Voices are the
  provider's, and making a sample spends its key.
- **Every write is audited** (Audit log page): `provider.key.set`, `provider.key.removed`,
  `provider.activated`, `provider.deactivated`, `voice.synced`, `voice.updated`,
  `voice.reordered`, `voice.sample.made`.
- Dates are ISO 8601 strings in UTC.

### Errors common to every route

| Status | `code` | When |
|---|---|---|
| 401 | `UNAUTHENTICATED` | Missing, expired or invalid admin token. Refresh once, then sign in. |
| 403 | `FORBIDDEN` | The role lacks `providers.manage`. |
| 422 | `VALIDATION_FAILED` | A field is missing or out of range; `details` lists the messages. |

## 1. The provider key (Providers page)

Every provider route takes a **capability**: `speech_to_text` (Auto captions) or
`text_to_speech` (voices). A key is kept per provider *and* capability, so the xAI key for
captions and the one for voices are saved separately — paste the same key twice to use one for
both. One provider is active per capability.

Which providers can do what:

| Capability | Providers |
|---|---|
| `speech_to_text` | `deepgram`, `elevenlabs`, `xai` |
| `text_to_speech` | `xai` |

A provider asked for a capability it cannot do is refused: `422 VALIDATION_FAILED`, e.g.
"Deepgram cannot do text to speech."

### `GET /providers?capability=text_to_speech`

The providers that can do the capability, each with its state:

```json
[{ "provider": "xai", "capability": "text_to_speech", "configured": true, "active": true, "updatedAt": "…" }]
```

A missing or unknown `capability` → 422.

### `PUT /providers/{provider}/key`

```json
{ "capability": "text_to_speech", "apiKey": "xai-…" }
```

→ `{ "configured": true }`. The key is trimmed, 8–512 characters, no spaces or line breaks, and
stored encrypted; it is never sent back.

### `DELETE /providers/{provider}/key?capability=text_to_speech`

→ `{ "configured": false }`.

### `POST /providers/{provider}/activate` / `POST /providers/{provider}/deactivate`

Body `{ "capability": "text_to_speech" }`. Activating switches off the capability's previous
provider in the same step. Both answer the capability's list, as `GET /providers` does.
With no active `text_to_speech` provider the app's voices are refused
(`503 TTS_UNAVAILABLE`) and the voice actions below cannot run.

### `POST /providers/{provider}/test`

Body `{ "capability": "text_to_speech" }` → `{ "ok": true, "message": "…" }`. Checks the saved
key with the provider without spending anything; `ok: false` says why (no key saved, refused,
unreachable).

## 2. Voices (Voices page)

The voices the app offers. A voice comes from the provider (**Sync**), starts **switched off**,
and is switched on by the owner once it has a **sample** — so the app never lists a voice it
cannot let the user hear. The app lists the voices that are switched on, in this page's order,
by their `label`.

A voice as returned:

```json
{
  "id": "clx8f2…",
  "provider": "xai",
  "providerVoiceId": "eve",
  "label": "Eve",
  "sortOrder": 0,
  "enabled": true,
  "sampleStorageId": "clx1a0…",
  "sampleStorageKey": "slimshot/voices/samples/0c1f….mp3",
  "sampleUrl": "https://cdn.example.com/slimshot/voices/samples/0c1f….mp3",
  "createdAt": "…",
  "updatedAt": "…"
}
```

`sampleUrl` is `null` until a sample is made. Play it straight from the URL.

### `GET /voices`

Every voice, switched on or not, in order (`sortOrder`, then `label`).

### `POST /voices/sync` → `200`

Asks the active `text_to_speech` provider for its voices and adds the ones not yet here:
switched off, labelled with the provider's name for the voice (or its id), after the last one.
A voice already here keeps its label, order and switch. A voice the provider no longer lists is
**kept** — a project mid-edit never loses the voice it chose; switch it off to stop offering it.
Answers the whole list.

- `503 TTS_UNAVAILABLE`: no active text-to-speech key ("Add an xAI key under Text to speech on
  the Providers page, and switch it on.").
- `502 PROVIDER_FAILED`: the provider refused or could not be reached; its message says why.

### `PATCH /voices/{id}`

```json
{ "label": "Eve", "enabled": true }
```

Either field, or both. `label` is trimmed, 1–40 characters. Answers the voice.

- `409 CONFLICT`: switching on a voice with no sample ("Make a sample before switching this
  voice on.").
- `404 NOT_FOUND`: unknown voice.

### `PUT /voices/order`

```json
{ "ids": ["clx8f3…", "clx8f2…", "clx8f4…"] }
```

Every voice's id exactly once, top to bottom. Answers the list in its new order.
Anything else → `422 VALIDATION_FAILED` ("Send every voice exactly once.").

### `POST /voices/{id}/sample` → `200`

Speaks **"Hi! This is how I sound in your video."** in the voice through the active provider,
stores the MP3 in the default storage under a new name (`slimshot/voices/samples/<uuid>.mp3`),
and replaces the voice's old sample, whose file is then deleted. Answers the voice with its new
`sampleUrl`. Every voice says the same sentence, so samples compare like for like. This is the
owner's provider spend — no user's credits.

- `503 TTS_UNAVAILABLE`: no active text-to-speech key.
- `502 PROVIDER_FAILED`: the provider refused or could not be reached; the old sample stays.
- `404 NOT_FOUND`: unknown voice.
