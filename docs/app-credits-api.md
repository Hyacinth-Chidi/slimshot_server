# SlimShot app API: accounts and credits

The contract between the SlimShot Android app and the server for accounts, sign-in, credits,
rewarded ads and account deletion. The app is built from this file, so it is kept exact and
current.

> **Status:** Milestone 1 (accounts and sign-in) is live. Credits, paid captions, referrals and
> rewarded ads are added to this file as they ship.

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

`referralCode` is optional. `200` → `{ "user": { …/me… }, "bonus": …, "referral": … }`. In this
milestone `bonus` and `referral` are `null`; the next milestone fills them.

## 9. Deleting the account

**In the app (Settings):** show a confirm screen, then

`DELETE /me` with the JSON body `{ "confirm": "DELETE" }` → `200 { "deleted": true }`. Clear the
stored tokens afterwards. (Dart's `http.delete` has no body parameter; build an
`http.Request('DELETE', uri)` and set `body` and the `Content-Type` header.)

What happens: sessions end, the email, username and Google link are erased, credits are forfeited.

**Without the app:** Google Play requires a web route. It is
`https://<server>/account-deletion` (email → 6-digit code → confirm). Put that URL in the Play
Console's account deletion field.

## 10. Errors

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
| 422 | `VALIDATION_FAILED` | a malformed request; `details` lists the problems | fix the request |
