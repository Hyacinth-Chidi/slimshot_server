# SlimShot app API: text to speech

The contract between the SlimShot Android app and the server for **voices made from texts**: the
app sends the words of the texts on its timeline, the server speaks them in a voice the user
picked and charges credits for it. The app is built from this file, so it is kept exact and
current.

Sign-in, tokens, the response envelope, credits and the price quote are the accounts contract's:
[`docs/app-credits-api.md`](../app-credits-api.md). This file adds what is particular to voices.

> **Status:** built, not yet deployed.

## Basics

- **Base URL:** `https://<server>/api/app/v1` (local: `http://<your-machine-ip>:2700/api/app/v1`).
- **Envelope:** the accounts contract's — `{ "success": true, "data": … }` or
  `{ "success": false, "error": { "code", "message", "details"?, "traceId" } }`. Branch on
  `error.code`, never on `message`. The voice download (§3) is the one answer that is not JSON.
- **A character is a Unicode code point of the trimmed text.** The server counts each text after
  trimming it and adds them up; that sum is what is priced and charged. In Dart, send every text
  already trimmed (`text.trim()`) and count `text.runes.length` of exactly what you send: the
  server's trim then removes nothing more, and both sides agree on accents and emoji alike —
  `"héllo 👍🏽"` is 8 characters (the thumb and its skin tone are two).

| Limit | Value |
|---|---|
| Texts in one request | 1–100 |
| Characters in one text | 1–2 000 |
| Characters in one request (all texts) | at most 20 000 |
| Text id | 1–64 letters, digits, `-` or `_`; unique within the request |
| How long a finished voice can be downloaded | 60 minutes after its job finished |

These are the server's settings as shipped (the character limits can only be lowered). A request
past the server's limits is refused (§4) before anything is charged.

## 1. Voices — `GET /voices`

Public: no sign-in, like the catalogue. The voices the owner offers, in the owner's order:

```json
[
  { "id": "clx8f2…", "label": "Eve", "sampleUrl": "https://cdn.example.com/slimshot/voices/samples/0c1f….mp3" },
  { "id": "clx8f3…", "label": "Rex", "sampleUrl": "https://cdn.example.com/slimshot/voices/samples/9a27….mp3" }
]
```

- `id` is what a request names (§3). `label` is the name to show.
- `sampleUrl` is a short MP3 of the voice saying "Hi! This is how I sound in your video." Play
  it straight from the URL: **samples are free** and need no sign-in. Never store a `sampleUrl`:
  it may stop working, like a font's download address. Fetch the list when the picker opens.
- Only voices that are switched on and have a sample are listed. An **empty list** means text to
  speech is not offered right now: don't offer the tool.
- Ask again whenever the voice picker opens; the owner can switch a voice off at any time. A
  voice switched off after the app listed it is refused when used (`404 VOICE_NOT_FOUND`).
- Limited per IP at the catalogue's rate: `429 RATE_LIMITED` with `details.retryAfterSeconds`.

## 2. Price — `POST /credits/quote`

Signed in, as for Auto captions (accounts contract §11), with the characters of the texts you are
about to send:

```json
{ "feature": "text_to_speech", "characters": 342 }
```

`characters` is 1–20 000. `200` → `{ "credits": 4, "balance": 94, "enough": true, "pricingVersion": 2 }`.
When `enough` is false, offer ways to earn credits instead.

Always ask; never compute the price in the app. The owner prices a request flat or by the
characters (for example 1 credit per started 500 characters, at least 1 per request) and can
change it at any time. The server counts the characters again when the request arrives and
charges what it counts.

`503 TTS_UNAVAILABLE`: text to speech is switched off (no price set): say it is unavailable right
now.

## 3. Making voices

1. Quote the texts (§2) and confirm with the user.
2. `POST /speech` with `Authorization: Bearer <accessToken>`, `Idempotency-Key: <uuid>` and a
   JSON body:

   ```json
   {
     "voiceId": "clx8f2…",
     "items": [
       { "id": "text_1", "text": "Welcome back to the channel." },
       { "id": "text_2", "text": "Today we are making jollof rice." }
     ]
   }
   ```

   - `id` is yours: the timeline's own id for the text works. The voice is downloaded under it.
   - Every text is spoken as one clip, on its own. Only `id` and `text` are accepted in an item.

   `202` →

   ```json
   { "jobId": "tts_4f0c…", "status": "queued", "pollAfterMs": 1500, "charged": { "credits": 4, "balance": 90 } }
   ```

   The credits are taken now, before the provider is called. `charged` is absent for a free
   request and for a resend of a request the server still has.
3. Poll `GET /speech/{jobId}` (same `Authorization`) every `pollAfterMs` until `completed` or
   `failed`. Stop after about 10 minutes and show a timeout message.
4. Download every voice: `GET /speech/{jobId}/items/{id}` (same `Authorization`) →
   `200`, `Content-Type: audio/mpeg`, the MP3's bytes (24 kHz, 128 kbps) with a `Content-Length`.
   Save each into the project's own folder at once: the server deletes a job's voices **60
   minutes** after the job finished.

**A job is all or nothing.** `completed` means every text has its voice; `failed` means none was
kept and **every credit was refunded** automatically (a `feature_refund` in the history and in
`/me`).

**Poll responses** (`200`):

- Still working: `{ "jobId", "status": "queued" | "processing", "pollAfterMs": 1500 }`.
- Done:

  ```json
  {
    "jobId": "tts_4f0c…",
    "status": "completed",
    "items": [{ "id": "text_1", "durationSeconds": 2.448 }, { "id": "text_2", "durationSeconds": 3.072 }]
  }
  ```

  `durationSeconds` is how long that voice plays, read from the MP3 itself to the millisecond:
  the clip's length on the timeline.
- Failed: `{ "jobId", "status": "failed", "error": { "code": "PROVIDER_FAILED" | "TTS_UNAVAILABLE", "message" } }`
  — the credits are already back; the user can try again (with a new key).

**Retrying a request.** If the `POST` times out or the connection drops, send it again with the
**same** `Idempotency-Key`: the server answers with the job it already has and charges nothing
more. Use a new key for every new request, including a new attempt after a `failed` result. A key
is good for one request only: once its job has finished more than 60 minutes ago, or after the
server answered `409 IDEMPOTENCY_KEY_REUSED`, send the request again with a **new** key (nothing
was charged for the refused one).

`404 NOT_FOUND` from the poll: unknown job, someone else's job, or one that finished more than 60
minutes ago. From a download, also: an id that is not in the job, a job not finished yet, or a
voice already deleted — make it again with a new request.

**Dart sketch** (`package:http`, `uuid`; `_data` unwraps the envelope and throws on
`success: false`; on `401 UNAUTHENTICATED` refresh once and retry):

```dart
/// Speaks [texts] (id → words, already trimmed) in [voiceId]; returns id → saved MP3.
Future<Map<String, File>> speak(String accessToken, String voiceId, Map<String, String> texts, Directory into) async {
  final key = const Uuid().v4(); // reuse the same key if you resend this request
  final auth = {'Authorization': 'Bearer $accessToken'};
  final body = jsonEncode({
    'voiceId': voiceId,
    'items': [for (final e in texts.entries) {'id': e.key, 'text': e.value}],
  });

  var job = _data((await http.post(Uri.parse('$base/speech'),
          headers: {...auth, 'Content-Type': 'application/json', 'Idempotency-Key': key}, body: body))
      .body);
  final deadline = DateTime.now().add(const Duration(minutes: 10));
  while (job['status'] == 'queued' || job['status'] == 'processing') {
    if (DateTime.now().isAfter(deadline)) throw SpeechException('TIMEOUT', 'Making the voice took too long.');
    await Future.delayed(Duration(milliseconds: (job['pollAfterMs'] as int?) ?? 1500));
    job = _data((await http.get(Uri.parse('$base/speech/${job['jobId']}'), headers: auth)).body);
  }
  if (job['status'] == 'failed') {
    final error = job['error'] as Map<String, dynamic>;
    throw SpeechException(error['code'] as String, error['message'] as String);
  }

  final files = <String, File>{};
  for (final item in job['items'] as List) {
    final id = (item as Map<String, dynamic>)['id'] as String;
    final res = await http.get(Uri.parse('$base/speech/${job['jobId']}/items/$id'), headers: auth);
    if (res.statusCode != 200) throw SpeechException('NOT_FOUND', 'The voice is no longer available.');
    files[id] = await File('${into.path}/$id.mp3').writeAsBytes(res.bodyBytes);
  }
  return files;
}
```

**curl:**

```bash
curl -s http://localhost:2700/api/app/v1/voices

curl -s -X POST http://localhost:2700/api/app/v1/speech \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"voiceId":"clx8f2…","items":[{"id":"text_1","text":"Welcome back to the channel."}]}'

curl -s http://localhost:2700/api/app/v1/speech/$JOB_ID -H "Authorization: Bearer $ACCESS_TOKEN"

curl -s -o text_1.mp3 http://localhost:2700/api/app/v1/speech/$JOB_ID/items/text_1 \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

## 4. Errors

| Status | `error.code` | When | What the app does |
|---|---|---|---|
| 401 | `SIGN_IN_REQUIRED` | no sign-in | show the sign-in sheet |
| 401 | `UNAUTHENTICATED` | access token expired, session ended | refresh once, else sign in |
| 403 | `ACCOUNT_SUSPENDED` | the account is suspended | show "contact support" |
| 402 | `INSUFFICIENT_CREDITS` | not enough credits; `details.required`, `details.balance` | offer ways to earn credits |
| 404 | `VOICE_NOT_FOUND` | the voice is unknown or was switched off | load the voices again and ask the user to pick one |
| 413 | `TEXT_TOO_LONG` | a text over 2 000 characters (`details.itemId`, `details.characters`, `details.maxCharacters`), or the request over 20 000 (`details.characters`, `details.maxCharacters`); nothing charged | ask the user to shorten that text, or send the texts in two requests |
| 409 | `IDEMPOTENCY_KEY_REUSED` | this key's job is gone (finished over 60 minutes ago, or refused before); nothing charged | send the request again with a new key |
| 503 | `TTS_UNAVAILABLE` | text to speech is switched off (no provider or no price) | show "Voices are unavailable right now" |
| 404 | `NOT_FOUND` | unknown, someone else's or expired job; a voice not in the job or already deleted | make the voice again |
| 429 | `RATE_LIMITED` | too many voice-list requests; `details.retryAfterSeconds` | wait, then retry |
| 422 | `VALIDATION_FAILED` | a malformed request: no texts, more than 100, an empty text, a bad or repeated id, a missing or bad `Idempotency-Key`; `details` lists the problems | fix the request |

Inside a `failed` job (never as an HTTP status): `PROVIDER_FAILED` — the provider refused the
text or could not be reached; `TTS_UNAVAILABLE` — text to speech was switched off while the job
waited. Both are refunded.
