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
