# SlimShot app API: accounts and credits

The contract between the SlimShot Android app and the server for accounts, sign-in, credits,
rewarded ads and account deletion. The app is built from this file, so it is kept exact and
current.

> **Status:** accounts, sign-in, credits, paid Auto captions, the signup bonus, referrals and
> rewarded ads are live.

## Basics

- **Base URL:** `https://<server>/api/app/v1` (local: `http://<your-machine-ip>:2700/api/app/v1`).
- **Envelope:** every JSON response is
  - success: `{ "success": true, "data": … }`
  - failure: `{ "success": false, "error": { "code": "…", "message": "…", "details": { … }, "traceId": "…" } }`
- Branch on `error.code`, never on `message`. `details` is only present where this document
  says so. Include `traceId` in bug reports: it matches the server log line.

## Who does what

| Flow | App | Server |
|---|---|---|
| First launch | Registers the install once (`POST /devices`) and stores the device token. | Stores the token's SHA-256 only. |
| Google sign-in | Shows the Google account picker (no browser), gets an **ID token** for our server's client ID, sends it with the device token. | Checks the token with Google's keys (signature, audience, expiry, verified email). Finds or creates the account, links the install, returns tokens. |
| Email sign-in | Email field, then code field. | Blocks disposable domains, rate-limits, emails a 6-digit code, checks it, finds or creates the account. |
| Claim | Username field with live availability, optional referral code. | Validates the username, decides bonus and referral eligibility, grants credits, returns what was granted or why not. |
| Staying signed in | Stores both tokens securely. On `401 UNAUTHENTICATED` refreshes once; if that fails, shows sign-in. | Rotates refresh tokens; a reused old token ends the whole session. |
| Deletion | Confirm screen, `DELETE /me`, clears local tokens. | Revokes sessions, erases personal data, forfeits credits, keeps only anti-fraud hashes. |

## 1. The install token

Unchanged from the caption guide: `POST /devices` once per install (body optional:
`{ "platform": "android", "appVersion": "1.4.0" }`) → `201 { deviceId, token }`. Keep `token` in
secure storage. Every sign-in request sends it as `deviceToken`. It is **not** an access token:
sending it as `Authorization: Bearer` gets `401 SIGN_IN_REQUIRED`.

## 2. Google sign-in

**Google Cloud setup (once):** create two OAuth clients in the same Google Cloud project:
- an **Android** client with the app's package name and its SHA-1 signing fingerprint
  (add both the debug and the Play signing SHA-1);
- a **Web** client. The app passes the **Web client ID** to the Google SDK as its server
  client ID (`serverClientId`). That ID is also the server's `GOOGLE_CLIENT_IDS`.

**In the app:** use the Google account picker (Credential Manager / `google_sign_in`). It shows
the Google accounts already on the phone; no browser. Ask it for an **ID token** for the Web
client ID, then:

`POST /auth/google`

```json
{ "idToken": "<ID token from the Google SDK>", "deviceToken": "<install token>" }
```

`200` → the sign-in response (§4).

## 3. Email code sign-in

`POST /auth/email/start`

```json
{ "email": "ann@example.com", "deviceToken": "<install token>" }
```

`200` → `{ "sentTo": "ann@example.com", "resendAfterSeconds": 60, "expiresInSeconds": 600 }`. The
answer is the same whether or not an account exists. Codes are 6 digits, valid 10 minutes, 5
tries; a new code can be requested after `resendAfterSeconds`.

`POST /auth/email/verify`

```json
{ "email": "ann@example.com", "code": "123456", "deviceToken": "<install token>" }
```

`200` → the sign-in response (§4). The first successful sign-in creates the account.

## 4. The sign-in response

Both methods answer:

```json
{
  "accessToken": "eyJ…",
  "refreshToken": "q3V…",
  "expiresIn": 900,
  "isNewAccount": true,
  "needsClaim": true,
  "user": { …the /me object (§6)… }
}
```

`needsClaim: true` → show the username screen (§8) before anything else.

## 5. Tokens

- Send `Authorization: Bearer <accessToken>` on every signed-in call. It lasts `expiresIn`
  seconds (15 minutes).
- On `401 UNAUTHENTICATED`: call `POST /auth/refresh { "refreshToken": "…" }` **once** →
  `200 { accessToken, refreshToken, expiresIn }`, store both new tokens, and retry the request.
- **Never run two refreshes at the same time.** Every refresh token works once; presenting a used
  one ends the whole session (it looks like a stolen token). Make refresh single-flight: queue
  other requests behind the one refresh in progress.
- On `401 SIGN_IN_REQUIRED`, or when the refresh fails: clear tokens and show the sign-in sheet.
- `POST /auth/logout { "refreshToken": "…" }` → `200 { "loggedOut": true }`; then clear tokens.
- Store both tokens in secure storage (`flutter_secure_storage`).

## 6. `GET /me`

```json
{
  "id": "cmg…",
  "email": "ann@example.com",
  "username": "ann_1",
  "referralCode": "AB3DEF7K",
  "creditBalance": 94,
  "accountStatus": "active",
  "needsClaim": false,
  "signInMethods": { "google": true, "email": true },
  "ads": { "rewardCredits": 5, "dailyCap": 10, "remainingToday": 7 }
}
```

- `accountStatus`: `active` or `suspended`. A suspended account can sign in and look, but cannot
  spend credits, watch rewarded ads or claim.
- `referralCode`: the user's own code to share (not the username).
- `ads.remainingToday` resets at 00:00 UTC.

## 7. Username

Rules: 3–20 characters, `a–z`, `0–9` and `_`; case-insensitive (stored lowercase); some names are
reserved. Private: shown only to the user.

- `GET /usernames/{name}/availability` → `{ "username": "ann_1", "available": true }` or
  `{ "username": "ab", "available": false, "reason": "INVALID" | "RESERVED" | "TAKEN" }`. At most
  60 checks per minute: debounce typing (~300 ms).
- `PATCH /me/username { "username": "new_name" }` → the `/me` object.

## 8. Claim (the first-run step)

`POST /me/claim`

```json
{ "username": "ann_1", "referralCode": "AB3DEF7K" }
```

`referralCode` is optional (any case; spaces ignored). `200` →

```json
{
  "user": { …/me… },
  "bonus": { "granted": true, "credits": 100 },
  "referral": { "outcome": "rewarded", "credits": 20 }
}
```

- `bonus.granted: false` comes with a `reason`; the account is set up either way:
  - `BONUS_ALREADY_CLAIMED`: this email (or this phone's app install) already received a signup
    bonus, including on an account that was deleted since.
  - `IP_LIMIT_REACHED`: too many new accounts from this network today.
- `referral` is `null` without a code. Otherwise `outcome` is:
  - `rewarded`: both people get credits (`credits` is what this user got);
  - `inviter_capped`: this user gets credits; the friend has hit their referral limit;
  - `invitee_ineligible`: nobody gets referral credits, because this user is not new.
- An unknown code, the user's own code, or a code of a suspended account answers
  `422 REFERRAL_CODE_INVALID` and nothing is saved: let the user fix or remove the code.

**Referral codes.** Every user has `referralCode` in `/me` (it is not the username). Show it with a
share button. A friend enters it on their claim screen; both earn credits only when the friend's
email and phone are new to SlimShot.

## 9. Deleting the account

**In the app (Settings):** show a confirm screen, then

`DELETE /me` with the JSON body `{ "confirm": "DELETE" }` → `200 { "deleted": true }`. Clear the
stored tokens afterwards. (Dart's `http.delete` has no body parameter; build an
`http.Request('DELETE', uri)` and set `body` and the `Content-Type` header.)

What happens: sessions end, the email, username and Google link are erased, credits are forfeited.

**Without the app:** Google Play requires a web route. It is
`https://<server>/account-deletion` (email → 6-digit code → confirm). Put that URL in the Play
Console's account deletion field.

## 10. Credits

- The balance is `creditBalance` in `/me`. Credits are whole numbers and never go below zero.
- `GET /credits/history?cursor=&limit=` (`limit` 1–100, default 20), newest first:

  ```json
  {
    "items": [
      { "id": "cm1…", "type": "feature_charge", "amount": -6, "balanceAfter": 94, "createdAt": "2026-10-03T12:00:00.000Z" }
    ],
    "nextCursor": "cm1…"
  }
  ```

  Pass `nextCursor` as `cursor` for the next page; `null` means the end.
- `type` values: `signup_bonus` (claim bonus), `referral_invitee` / `referral_inviter` (referral
  rewards), `rewarded_ad` (watched an ad), `feature_charge` (paid for a feature, negative),
  `feature_refund` (a failed job gave its credits back), `admin_adjustment` (support changed the
  balance), `account_deleted` (credits forfeited on deletion), `purchase` (reserved for payments).

## 11. Price quote

Show the price before the user generates:

`POST /credits/quote`

```json
{ "feature": "auto_captions", "durationSeconds": 125.4 }
```

`200` → `{ "credits": 6, "balance": 94, "enough": true, "pricingVersion": 3 }` → "This will use
6 credits · You have 94". When `enough` is false, offer ways to earn credits instead.

Always ask; never compute the price in the app. The owner can price a job flat, by length
brackets, or by the second (for example 1 credit per started 10 s, at least 2 per job), and can
switch between them at any time.

Use the duration of the exact WAV you are about to upload: the server measures that file again
and charges what it measures.

## 12. Auto captions (paid)

Captions need a signed-in user with enough credits. The flow:

1. Extract the audio as **WAV** (mono, 16 kHz, 16-bit PCM). The server reads the duration from
   the WAV header, so other formats are refused:

   ```bash
   ffmpeg -i input.mp4 -vn -ac 1 -ar 16000 -c:a pcm_s16le audio.wav
   ```

   That is about 1.9 MB per minute; the default 50 MB limit is about 26 minutes.
2. Quote it (§11) and confirm with the user.
3. `POST /captions` with `Authorization: Bearer <accessToken>`, `Idempotency-Key: <uuid>`, and
   `multipart/form-data`:
   - `audio` (file, required) with the part content type **`audio/wav`** (Flutter's
     `MultipartFile.fromPath` sends `application/octet-stream` unless you pass `contentType`);
   - `language` (optional): a two-letter ISO 639-1 code (`en`, `fr`, `yo`); omit to detect.

   `202` →

   ```json
   { "jobId": "cap_4f0c…", "status": "queued", "pollAfterMs": 1500, "charged": { "credits": 6, "balance": 88 } }
   ```

   The credits are taken now, before the provider is called. `charged` is absent for a free job
   and for a resend of an upload the server still has.
4. Poll `GET /captions/{jobId}` (same `Authorization`) every `pollAfterMs` until `completed` or
   `failed`. A finished result is deleted after **3 minutes**, so use it right away.

**Retrying an upload.** If the upload times out or the connection drops, send it again with the
**same** `Idempotency-Key`: the server answers with the job it already has and charges nothing
more. Use a new key for every new upload, including a new attempt after a `failed` result.
A key is good for one upload only: once its job's result has expired, or after the server
answered `409 IDEMPOTENCY_KEY_REUSED`, send the upload again with a **new** key.

**Failed jobs are refunded automatically.** The refund appears in the history and in `/me`.

**Poll responses** (`200`):

- Still working: `{ "jobId", "status": "queued" | "processing", "pollAfterMs": 1500 }`.
- Done:

  ```json
  {
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
  ```

  - `words` holds spoken words only, in order, with punctuation attached (`"channel."`); no
    spaces and no sound effects.
  - `start` and `end` are seconds from the start of the uploaded audio; `confidence` is 0–1.
  - `language` is the code you sent, or the detected one (two or three letters, `en` or `eng`).
  - `durationSeconds` may be `null`.
  - Silence or music gives `"text": ""` and `"words": []`: show "No speech found".
- Failed: `{ "jobId", "status": "failed", "error": { "code": "PROVIDER_FAILED" | "CAPTIONS_UNAVAILABLE", "message" } }`
  (credits already refunded; the user can try again with a new key).

`404 NOT_FOUND`: unknown job, another user's job, or a result older than 3 minutes. Stop polling
after about 10 minutes and show a timeout message.

**Dart sketch** (`package:http`, `http_parser`, `uuid`):

```dart
Future<Map<String, dynamic>> autoCaption(String accessToken, String wavPath, {String? language}) async {
  final key = const Uuid().v4(); // reuse the same key if you resend this upload
  final request = http.MultipartRequest('POST', Uri.parse('$base/captions'))
    ..headers['Authorization'] = 'Bearer $accessToken'
    ..headers['Idempotency-Key'] = key
    ..files.add(await http.MultipartFile.fromPath('audio', wavPath, contentType: MediaType('audio', 'wav')));
  if (language != null) request.fields['language'] = language;

  var job = _data((await http.Response.fromStream(await request.send())).body);
  final deadline = DateTime.now().add(const Duration(minutes: 10));
  while (job['status'] == 'queued' || job['status'] == 'processing') {
    if (DateTime.now().isAfter(deadline)) throw CaptionException('TIMEOUT', 'Captioning took too long.');
    await Future.delayed(Duration(milliseconds: (job['pollAfterMs'] as int?) ?? 1500));
    final res = await http.get(Uri.parse('$base/captions/${job['jobId']}'), headers: {'Authorization': 'Bearer $accessToken'});
    job = _data(res.body);
  }
  if (job['status'] == 'failed') {
    final error = job['error'] as Map<String, dynamic>;
    throw CaptionException(error['code'] as String, error['message'] as String);
  }
  return job['result'] as Map<String, dynamic>;
}
```

`_data` unwraps the envelope and throws on `success: false`; on `401 UNAUTHENTICATED` refresh
once (§5) and retry.

**curl:**

```bash
curl -s -X POST http://localhost:2700/api/app/v1/captions \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" \
  -F "audio=@audio.wav;type=audio/wav" -F "language=en"
```

## 13. Rewarded ads

The user watches a rewarded ad to earn credits. **The app never grants credits itself:** AdMob
tells our server directly (server-side verification, SSV), and the app only asks how it went.

**AdMob setup (once, in the AdMob console):** on every rewarded ad unit the app uses, turn on
server-side verification and set the callback URL to
`https://<server>/api/app/v1/rewards/admob/ssv`. The server only accepts callbacks from the ad
units listed in its `ADMOB_AD_UNIT_IDS`, so send those IDs to whoever runs the server (the full
`ca-app-pub-…/1234567890` form from the console is fine).

**The flow:**

1. When the user taps "Watch an ad" (for example after `402 INSUFFICIENT_CREDITS`, or from the
   credits screen):

   `POST /rewards/ads/session` (signed in) →

   ```json
   { "nonce": "q1w2…", "ssvUserId": "cmg…", "rewardCredits": 5, "adsRemainingToday": 7 }
   ```

   `409 AD_DAILY_CAP_REACHED` with `details.resetsAt` (UTC midnight) means no more rewarded ads
   today: hide the button until then. `/me.ads` gives the same numbers for drawing the button.
2. Load the rewarded ad and, **before showing it**, set its server-side verification options:
   `userId = ssvUserId` and `customData = nonce` (Flutter `google_mobile_ads`:
   `ServerSideVerificationOptions(userId: ssvUserId, customData: nonce)` on the rewarded ad).
   A new session (and nonce) for every ad.
3. Show the ad. When it closes (whether or not the app's `onUserEarnedReward` fired), poll
   `GET /rewards/ads/session/{nonce}` about once a second for up to 30 seconds:

   ```json
   { "status": "granted", "credits": 5, "balance": 99 }
   ```

   - `pending`: AdMob has not called the server yet; keep polling.
   - `granted`: show "+5 credits"; `balance` is the new balance.
   - `capped`: the daily limit was reached while the ad played; no credits.
   - `rejected`: the reward was refused (for example the account is suspended).

   If it is still `pending` after 30 seconds, stop and refresh `/me` later: a late callback still
   lands. A nonce lasts one hour; another user's nonce answers `404 NOT_FOUND`.

## 14. Errors

| Status | `error.code` | When | What the app does |
|---|---|---|---|
| 401 | `SIGN_IN_REQUIRED` | no sign-in (or the install token sent as a bearer) | show the sign-in sheet |
| 401 | `UNAUTHENTICATED` | access token expired, session ended or account deleted | refresh once (§5), else sign in |
| 422 | `DEVICE_NOT_REGISTERED` | unknown `deviceToken` | `POST /devices`, store the new token, retry |
| 401 | `GOOGLE_TOKEN_INVALID` | Google did not vouch for the ID token | ask the user to pick the account again |
| 422 | `GOOGLE_EMAIL_UNVERIFIED` | the Google account has no verified email | offer email sign-in |
| 503 | `SIGN_IN_METHOD_UNAVAILABLE` | Google sign-in is not set up on the server | offer email sign-in |
| 422 | `EMAIL_DOMAIN_NOT_ALLOWED` | a disposable email address | ask for a regular email |
| 409 | `ACCOUNT_LINK_CONFLICT` | the email belongs to an account linked to another Google account | ask the user to use that Google account or email sign-in |
| 422 | `OTP_INVALID` | wrong code; `details.attemptsLeft` | show "wrong code, N tries left" |
| 422 | `OTP_EXPIRED` | no live code (expired, used, or never sent) | offer "send a new code" |
| 429 | `OTP_ATTEMPTS_EXCEEDED` | 5 wrong codes | offer "send a new code" |
| 429 | `OTP_RESEND_TOO_SOON` | asked again too soon; `details.retryAfterSeconds` | count down, then allow resend |
| 429 | `RATE_LIMITED` | too many requests; `details.retryAfterSeconds` | wait, then retry |
| 422 | `USERNAME_INVALID` | breaks the username rules or is reserved | show the rule |
| 409 | `USERNAME_TAKEN` | someone has it | ask for another |
| 409 | `ALREADY_CLAIMED` | claim called twice | go to the main screen |
| 403 | `ACCOUNT_SUSPENDED` | the account is suspended | show "contact support" |
| 422 | `REFERRAL_CODE_INVALID` | unknown, own or suspended referral code | let the user fix or remove it |
| 402 | `INSUFFICIENT_CREDITS` | not enough credits; `details.required`, `details.balance` | offer ways to earn credits |
| 415 | `UNSUPPORTED_MEDIA` | the `audio` part is not WAV | upload `audio/wav` |
| 422 | `INVALID_AUDIO` | the WAV cannot be read (not PCM or float, empty, broken header) | extract it again (§12) |
| 409 | `IDEMPOTENCY_KEY_REUSED` | this `Idempotency-Key` already paid for an earlier upload whose job is gone; nothing was charged | resend the upload with a new key |
| 413 | `PAYLOAD_TOO_LARGE` | the audio is over the size limit | split the video's audio |
| 503 | `CAPTIONS_UNAVAILABLE` | Auto caption is switched off or has no price set | show "Auto caption is unavailable right now" |
| 404 | `NOT_FOUND` | unknown, someone else's, or expired caption job or ad session | start again |
| 409 | `AD_DAILY_CAP_REACHED` | today's rewarded ads are used up; `details.resetsAt` | hide "Watch an ad" until then |
| 422 | `VALIDATION_FAILED` | a malformed request; `details` lists the problems | fix the request |
