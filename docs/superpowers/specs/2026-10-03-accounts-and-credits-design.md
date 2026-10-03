# Accounts and credits — design

**Date:** 2026-10-03
**Status:** Awaiting the owner's review of this written spec
**Repo:** `slimshot_server` (server and admin API). The admin dashboard screens and the Flutter app
are built afterwards from the admin API and from `docs/app-credits-api.md`.
**Source brief:** `credits_sytem.md` (the owner's product brief). This spec follows it except where
§2 records a change agreed in conversation.

## 1. Purpose

The SlimShot app is free and works without an account. Some features cost **credits**; the first is
Auto captions. A user signs in with Google or an emailed one-time code, picks a private username,
claims a free credit bonus, and earns more credits by watching rewarded ads or inviting friends.
Every amount, price and limit is set by the admin. This phase builds the server side of all of it,
the admin API, and the exact app contract. Payments come next; the ledger reserves a `purchase` type.

## 2. Decisions

Agreed with the owner:

| Question | Decision |
|---|---|
| Audio format for paid captions | **WAV only** (mono 16 kHz from the app). The server reads the duration from the WAV header. |
| Email delivery | **SMTP from `.env`** (nodemailer). `EMAIL_SENDER=log` prints codes in development. |
| Dashboard screens | Not in this phase. This phase delivers the **admin API**; the screens are the next plan. |
| Staging | One branch, **four milestones** (§19); the owner tests after each. |
| Per-device bonus rule | **The Android ID is not used.** Google Play's User Data policy forbids linking persistent device identifiers (Android ID/SSAID) to personal data, whatever a privacy policy says. The rule is **one bonus per verified email and per app install** (the device token from `POST /devices`). Play Integrity *device recall* is a later hardening step. |
| Account deletion on the web | Required by Google Play. The server **serves the small deletion page itself** (`GET /account-deletion`) plus its two endpoints. |
| Out of credits | The app decides what to show (for example "Watch an ad"). The server returns `402` with `required` and `balance`, and `/me` carries the ad reward and ads left today. |

Settled in this spec (the brief was silent or ambiguous):

1. **Soft IP limit:** past N new accounts per IP in 24 h, the account is still created, but it is
   not eligible for the signup bonus or a referral reward (reason `IP_LIMIT_REACHED`). Nobody
   behind a carrier IP is locked out.
2. **Bonus email key is canonical:** lowercase, `+tag` removed, and for `gmail.com`/`googlemail.com`
   dots removed. `ann+1@gmail.com` and `a.nn@gmail.com` count as the same email for the bonus. The
   account itself keeps the address as entered (lowercased).
3. **Forfeiting credits on deletion** writes a ledger row of a new type `account_deleted`, so the
   cached balance always equals the ledger sum.
4. **`DELETE /me` needs `{"confirm":"DELETE"}`.** The confirmation screen is the app's job.
5. **Ad reward** comes from settings, never from AdMob's `reward_amount`. Callbacks from ad units
   not in `ADMOB_AD_UNIT_IDS` are ignored (otherwise another publisher could point their ads at our
   callback with a nonce from our API).
6. **No active pricing rule** means `503 CAPTIONS_UNAVAILABLE` for the quote and for captions. A
   rule that prices a job at 0 credits makes it free (no ledger row).
7. **Referral cap reached:** the invitee still gets the invitee reward; the inviter gets nothing for
   that referral (outcome `inviter_capped`).
8. **Suspended users** can sign in and read their data, but cannot spend credits, start an ad
   session, or claim a bonus (`403 ACCOUNT_SUSPENDED`).
9. **`TRUST_PROXY`** (`.env`) makes Express read the client IP from the proxy header. Without it,
   behind nginx every request comes from the proxy and per-IP limits break.
10. **One app contract:** `docs/app-credits-api.md` documents every app endpoint, captions
    included. `docs/app-api/auto-caption.md` becomes a pointer to it.
11. **Default amounts** (all editable): signup bonus 100, ad reward 5, ads per day 10, referral
    inviter 20 and invitee 20, 10 rewarded referrals per inviter per 30 days, 10 new accounts per IP
    per 24 h.
12. **Username reserved list** is a constant in code (admin, slimshot, support, …), not a setting.
13. **Orphaned charge:** if the server dies between charging and queueing a caption job, the
    credits stay charged until the app retries with the same `Idempotency-Key`; the retry reuses
    the charge and queues the job. No automatic refund for a request that is never retried.

## 3. What the app does and what the server does

| Flow | App | Server |
|---|---|---|
| First launch | Registers the install once (`POST /devices`) and stores the device token. | Stores the token's SHA-256 only. |
| Google sign-in | Shows the Google SDK account picker (no browser), gets an **ID token** for our server's client ID, sends it with the device token. | Verifies the token with Google's public keys (signature, audience, expiry, verified email). Finds or creates the account, links the install, returns tokens. |
| Email sign-in | Email field, then code field. | Blocks disposable domains, rate-limits, emails a 6-digit code, checks it, finds or creates the account. |
| Claim | Username field with live availability, optional referral code. | Validates the username, decides bonus and referral eligibility, grants credits, returns what was granted or why not. |
| Staying signed in | Stores both tokens securely. On `401 UNAUTHENTICATED` refreshes once; if that fails, shows sign-in. | Rotates refresh tokens; a reused old token ends the whole session. |
| Captions | Extracts mono 16 kHz WAV, asks for a quote ("This will use 6 credits · You have 94"), uploads on confirm, handles `402`. | Measures the WAV itself, prices it, charges, runs the job, refunds automatically on failure. |
| Rewarded ads | Gets a nonce, loads the AdMob ad with SSV `userId` + `customData = nonce`, shows it, polls the result. | Issues the nonce, receives AdMob's signed callback directly from Google, verifies it, grants once, answers the poll. |
| Referrals | Shows the user's code with a share button; takes a friend's code on the claim screen. | Rewards both sides only when the new account is truly new. |
| Deletion | Confirm screen, `DELETE /me`, clears local tokens. | Revokes sessions, erases personal data, forfeits credits, keeps only anti-fraud hashes. |

## 4. Architecture

New modules under `src/modules/`, following the existing patterns (config namespaces, envelope,
`AllExceptionsFilter`, `AuditService`, Redis via `REDIS`):

- **`accounts/`** — app users.
  - `google-verifier.ts` (google-auth-library `OAuth2Client.verifyIdToken`)
  - `otp.service.ts` (codes in Redis), `email-sender.ts` (interface; `LogEmailSender`, `SmtpEmailSender`)
  - `user-tokens.service.ts` (access JWT + refresh rotation), `user-auth.guard.ts`, `current-app-user.decorator.ts`
  - `accounts.service.ts` (resolve/create/link accounts), `username.ts` (rules, reserved list)
  - `account-deletion.service.ts`, `deletion-page.controller.ts`
  - controllers: `app-auth.controller.ts`, `me.controller.ts`, `account-deletion.controller.ts`
- **`credits/`** — money logic.
  - `ledger.service.ts` (the only writer of `CreditTransaction` and `User.creditBalance`)
  - `credit-settings.service.ts` (cached 30 s, cleared on update), `pricing.service.ts`
  - `bonus.service.ts`, `referral.service.ts`, `reconciliation.service.ts`
  - `credits.controller.ts` (quote, history)
- **`rewards/`** — `admob-verifier.ts` (keys cached ≤ 24 h), `ad-sessions.service.ts`, controllers.
- **`core/rate-limit/`** — `RateLimiter` (Redis fixed windows), used by OTP, sign-in and username checks.
- **`core/identity-hash.ts`** — `hmac(kind, value)` with `IDENTITY_HMAC_SECRET`.
- **`captions/`** (changed) — `UserAuthGuard` instead of `DeviceAuthGuard`; `wav.ts` header parser;
  pricing + charge in `start`; refund in the worker.
- **`admin/`** (new controllers) — credit settings, pricing rules, users, credit stats, reconciliation.

## 5. Configuration (`.env`, validated at boot)

| Variable | Default | Rule |
|---|---|---|
| `USER_JWT_SECRET` | — | required, ≥ 32 chars, must differ from `JWT_ACCESS_SECRET` |
| `USER_ACCESS_TTL_SECONDS` | `900` | 60–3600 |
| `USER_REFRESH_TTL_SECONDS` | `2592000` (30 d) | 86400–7776000 |
| `IDENTITY_HMAC_SECRET` | — | required, ≥ 32 chars. **Never change it**: bonus history is keyed by it. |
| `GOOGLE_CLIENT_IDS` | empty | comma list of OAuth **Web** client IDs. Empty → Google sign-in answers `503 SIGN_IN_METHOD_UNAVAILABLE`. |
| `EMAIL_SENDER` | `log` | `log` or `smtp`; `log` is refused when `NODE_ENV=production` |
| `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_SECURE` (false), `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM` | — | required when `EMAIL_SENDER=smtp` |
| `ADMOB_AD_UNIT_IDS` | empty | comma list; required when `NODE_ENV=production` |
| `ADMOB_VERIFIER_KEYS_URL` | `https://www.gstatic.com/admob/reward/verifier-keys.json` | URL |
| `TRUST_PROXY` | `false` | `false`, `true`, or a hop count |

New namespaces `appAuthConfig`, `emailConfig`, `admobConfig`; `TRUST_PROXY` joins `appConfig`.

## 6. Data model (Prisma)

```prisma
enum CreditTxType { signup_bonus referral_inviter referral_invitee rewarded_ad feature_charge feature_refund admin_adjustment account_deleted purchase }
enum CreditFeature { auto_captions }
enum PricingMode { per_job duration_tiers }
enum BonusClaimKind { email install }
enum ReferralOutcome { rewarded invitee_ineligible inviter_capped }

model User {                       // extends the existing stub; existing fields stay
  googleSub          String?  @unique
  username           String?  @unique      // lowercase a-z0-9_, 3–20
  referralCode       String?  @unique      // 8 chars, Crockford base32
  creditBalance      Int      @default(0)  // CHECK ("creditBalance" >= 0) in the migration
  claimedAt          DateTime?
  signupIpLimited    Boolean  @default(false)
  sessions UserSession[]
  ledger   CreditTransaction[]
}

model UserSession {                // one refresh-token family = one signed-in install
  id         String    @id @default(cuid())
  userId     String
  deviceId   String
  createdAt  DateTime  @default(now())
  lastUsedAt DateTime  @default(now())
  revokedAt  DateTime?
  refreshTokens UserRefreshToken[]
  @@index([userId, revokedAt])
}

model UserRefreshToken {
  id        String    @id @default(cuid())
  tokenHash String    @unique             // sha256
  sessionId String
  expiresAt DateTime
  revokedAt DateTime?
  createdAt DateTime  @default(now())
}

model Device { userId String? }    // added: the account last signed in on this install

model CreditTransaction {          // append-only; never updated or deleted
  id             String       @id @default(cuid())
  userId         String
  type           CreditTxType
  amount         Int                     // signed
  balanceAfter   Int
  idempotencyKey String       @unique    // "<type>:<reference>"
  reference      String?
  metadata       Json?
  createdAt      DateTime     @default(now())
  @@index([userId, createdAt(sort: Desc)])
  @@index([type, createdAt])
}

model BonusClaim {                 // no user link: survives account deletion
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
  @@index([inviterId, createdAt])
}

model CreditSettings {             // exactly one row, id "default", inserted by the migration
  id                         String   @id
  signupBonusCredits         Int
  adRewardCredits            Int
  adDailyCap                 Int
  referralInviterCredits     Int
  referralInviteeCredits     Int
  referralCapCount           Int
  referralCapDays            Int
  ipSignupLimitPer24h        Int
  disposableEmailDomains     String[]
  otpMaxAttempts             Int
  otpResendCooldownSeconds   Int
  otpPerEmailPerHour         Int
  otpPerDevicePerHour        Int
  otpPerIpPerHour            Int
  updatedById                String?
  updatedAt                  DateTime @updatedAt
}

model PricingRule {                // immutable once created; a change is a new version
  id            String        @id @default(cuid())
  feature       CreditFeature
  version       Int
  mode          PricingMode
  perJobCredits Int?
  tiers         Json?                    // [{ "upToSeconds": 60, "credits": 2 }, …, { "upToSeconds": null, "credits": 9 }]
  isActive      Boolean       @default(false)
  note          String?
  createdById   String
  createdAt     DateTime      @default(now())
  activatedAt   DateTime?
  @@unique([feature, version])
}
```

The migration is assembled offline (`prisma migrate diff`) and hand-finished with:
- `CHECK ("creditBalance" >= 0)` on `User`;
- `CREATE UNIQUE INDEX "PricingRule_one_active" ON "PricingRule"("feature") WHERE "isActive";`
- the `CreditSettings` default row (amounts in §2.11, OTP limits 5 attempts / 60 s / 5 per email
  per hour / 10 per install per hour / 20 per IP per hour, and a starter list of ~20 disposable
  domains such as mailinator.com, yopmail.com, guerrillamail.com, 10minutemail.com, temp-mail.org).

Tests pin each hand-written line, as the provider migration's partial index is pinned today.

## 7. Sign-in and sessions

**Device first.** Every sign-in request carries `deviceToken`; the server resolves it with
`DevicesService.authenticate`. Unknown or missing → `422 DEVICE_NOT_REGISTERED` (the app registers
and retries). No Android ID is sent or stored.

**Google** — `POST /auth/google {idToken, deviceToken}`:
1. `verifyIdToken({idToken, audience: GOOGLE_CLIENT_IDS})`; any failure → `401 GOOGLE_TOKEN_INVALID`.
2. `email` missing or `email_verified !== true` → `422 GOOGLE_EMAIL_UNVERIFIED`.
3. Disposable domain → `422 EMAIL_DOMAIN_NOT_ALLOWED`.
4. Account: by `googleSub`; else by email (link `googleSub`; an account already linked to a
   *different* Google ID → `409 ACCOUNT_LINK_CONFLICT`); else create.

**Email code** — `POST /auth/email/start {email, deviceToken}` then
`POST /auth/email/verify {email, code, deviceToken}`:
- Code: 6 digits from `crypto.randomInt`, stored in Redis as `HMAC(email|code)` with an attempts
  counter, TTL 10 minutes. One active code per email per purpose (`sign_in`, `delete_account`).
- Limits (from settings): resend cooldown (`429 OTP_RESEND_TOO_SOON {retryAfterSeconds}`), per
  email / per install / per IP per hour (`429 RATE_LIMITED {retryAfterSeconds}`).
- Verify: wrong code → `422 OTP_INVALID {attemptsLeft}`; the 5th wrong try deletes the code and
  answers `429 OTP_ATTEMPTS_EXCEEDED`; no code or expired → `422 OTP_EXPIRED`. Success deletes the code.
- `start` answers the same `200 {sentTo, resendAfterSeconds, expiresInSeconds}` whether or not an
  account exists.

**Account creation** (either method): lowercased email, a fresh `referralCode`; the per-IP 24 h
counter (Redis, keyed by `HMAC(ip)`) is incremented; past the limit, `signupIpLimited = true`.

**Tokens** (a separate system from admin auth):
- Access JWT: `USER_JWT_SECRET`, `aud: "slimshot-app"`, claims `{sub: userId, sid: sessionId}`, 15 min.
- Refresh: 48 random bytes, stored as SHA-256 under the session, 30 days, rotated on every use.
  Presenting a revoked refresh token revokes the whole session (`401 UNAUTHENTICATED`).
- Sign-in creates a `UserSession` for the install and sets `Device.userId`.
- `POST /auth/refresh {refreshToken}`, `POST /auth/logout {refreshToken}` (revokes the session).

**`UserAuthGuard`** (app routes): no bearer or a non-JWT bearer (for example an old device token) →
`401 SIGN_IN_REQUIRED`; bad or expired JWT → `401 UNAUTHENTICATED`; the session revoked or the
user deleted → `401 UNAUTHENTICATED`. One query loads the session with its user. Suspended users
pass the guard; spending paths check status.

**Sign-in response:** `{accessToken, refreshToken, expiresIn, isNewAccount, needsClaim, user}`
where `user` is the `/me` object.

## 8. Username

Normalised by trim + lowercase; must match `^[a-z0-9_]{3,20}$`, must not be reserved, must be free.
`GET /usernames/{name}/availability` (signed in, 60 per minute) → `{username, available, reason?}`
with reason `INVALID | RESERVED | TAKEN`. Set at claim; changed later with `PATCH /me/username`
(same rules; `409 USERNAME_TAKEN`, `422 USERNAME_INVALID`). Shown only to the user.

## 9. The ledger

`LedgerService.post({userId, type, amount, reference, metadata, requireActive})` runs one
transaction:

1. `UPDATE "User" SET "creditBalance" = "creditBalance" + $amount WHERE id = $1 AND "accountStatus" <> 'deleted' AND "creditBalance" + $amount >= 0 [AND "accountStatus" = 'active' when requireActive] RETURNING "creditBalance"`.
   No row → re-read the user to report `INSUFFICIENT_CREDITS {required, balance}`,
   `ACCOUNT_SUSPENDED`, or a deleted account.
2. `INSERT` the ledger row with `balanceAfter` and `idempotencyKey = "<type>:<reference>"`.
   A unique violation rolls the transaction back and returns the existing row as a replay —
   so the same ad transaction, referral or job is never applied twice, even concurrently.

The `CHECK` constraint is the last line of defence. `amount` is never 0 (callers skip zero grants).

Idempotency references: `signup_bonus:<userId>`, `referral_inviter|invitee:<referralId>`,
`rewarded_ad:<admobTransactionId>`, `feature_charge|feature_refund:<jobId>`,
`admin_adjustment:<uuid>`, `account_deleted:<userId>`.

**Reconciliation:** a daily job (first run 5 minutes after boot) compares each cached balance with
its ledger sum in one SQL query. A mismatch is logged as an error and audited
(`credits.reconcile.mismatch`); nothing is corrected automatically.
`GET /api/admin/v1/credits/reconciliation` runs the same check on demand.

## 10. Settings and pricing

`CreditSettings` holds every amount and limit; edited only through the admin API and audited.

Pricing rules are versioned and immutable. Creating one gets the next `version` for its feature;
activating it deactivates the previous one in the same transaction (partial unique index). Tier
validation: at least one tier, `upToSeconds` strictly ascending, only the last is `null`
(open-ended), credits are integers ≥ 0. Price of duration *d*: the first tier with
`d <= upToSeconds` (60.0 s → the "up to 60" tier; 60.001 s → the next). Each charge stores the
rule id, version and measured duration in its metadata, so changing a rule never alters a past charge.

`POST /credits/quote {feature: "auto_captions", durationSeconds}` (signed in) →
`{credits, balance, enough, pricingVersion}`. `durationSeconds` > 0 and ≤ 14400.

## 11. Paid captions

`POST /api/app/v1/captions` (signed in, multipart `audio`, optional `language`, header
`Idempotency-Key`), in order:

1. Account suspended → `403 ACCOUNT_SUSPENDED`.
2. `jobId = cap_ + sha256(userId:key)[0..32]`. A job with that id exists → return it, no charge.
3. The `audio` part must be `audio/wav`, `audio/x-wav`, `audio/wave` or `audio/vnd.wave` → else `415`.
4. Parse the WAV (`wav.ts`): `RIFF`/`WAVE`, walk chunks, `fmt ` PCM (format 1 or extensible), then
   `data`. Duration = data bytes ÷ byte rate, where data bytes is the declared size capped at the
   bytes actually present. Malformed, not PCM, or zero length → `422 INVALID_AUDIO`.
5. Price with the active rule → none active: `503 CAPTIONS_UNAVAILABLE`.
6. Charge `feature_charge:<jobId>` (requireActive) → `402 INSUFFICIENT_CREDITS {required, balance}`.
7. Write the temp file, queue the job with `{userId, filePath, mimeType, language, credits}`. If
   queueing fails: refund and delete the file.
8. `202 {jobId, status: "queued", pollAfterMs, charged: {credits, balance}}`.

Worker: on a terminal failure (provider refusal, last attempt, no provider) it posts
`feature_refund:<jobId>` for the charged amount before failing the job. A refund that fails is
logged and audited. The temp-file `rm` in `finally` can no longer throw (logged instead), so a
paid success never becomes a retry. Polling is scoped to the job's `userId`.

## 12. Signup bonus and anti-abuse

`POST /me/claim {username, referralCode?}` (signed in). Already claimed → `409 ALREADY_CLAIMED`;
suspended → `403 ACCOUNT_SUSPENDED`.

1. Validate the username and, if given, the referral code (unknown, own, or inviter not active →
   `422 REFERRAL_CODE_INVALID`) before writing anything.
2. Eligible when `signupIpLimited` is false (`IP_LIMIT_REACHED`) and neither the
   canonical-email HMAC nor the install HMAC (`HMAC(deviceId)` of the session's install) exists in
   `BonusClaim` (`BONUS_ALREADY_CLAIMED`).
3. In one transaction: insert both `BonusClaim` rows (a unique violation from a race →
   `BONUS_ALREADY_CLAIMED`), grant `signup_bonus`, set `username` and `claimedAt`, apply the referral (§13).
4. `200 {user, bonus: {granted, credits, reason?}, referral: {outcome, credits}?}`. An ineligible
   claim still succeeds, with `granted: false` and the reason.

Disposable domains are refused at sign-in. Delete-and-recreate earns nothing because `BonusClaim`
rows survive deletion.

## 13. Referrals

Applied only at claim, once per invitee. Self-referral is impossible (the invitee's own code is
not yet shown) and there are no chains (only the direct inviter is rewarded).
- Invitee not bonus-eligible → `invitee_ineligible`, nobody rewarded.
- Inviter has `referralCapCount` rewarded referrals in the last `referralCapDays` → `inviter_capped`;
  the invitee gets `referral_invitee`, the inviter nothing.
- Otherwise `rewarded`: `referral_inviter` and `referral_invitee`.

## 14. Rewarded ads (AdMob SSV)

- `POST /rewards/ads/session` (signed in, active) → daily cap reached: `409 AD_DAILY_CAP_REACHED
  {resetsAt}` (UTC midnight). Else a random nonce stored in Redis for 1 h with `{userId}` →
  `{nonce, ssvUserId: userId, rewardCredits, adsRemainingToday}`.
- The app sets SSV `userId = ssvUserId` and `customData = nonce` before showing the ad.
- `GET /api/app/v1/rewards/admob/ssv` (public, called by Google):
  1. Take the raw query string; the signed content is everything before `&signature=`;
     `signature` (base64url DER) and `key_id` are the last two parameters.
  2. Verify ECDSA-SHA256 with the key for `key_id` from the verifier-keys JSON (cached ≤ 24 h;
     an unknown `key_id` triggers one refetch). Invalid → `400`, nothing granted.
  3. `ad_unit` not in `ADMOB_AD_UNIT_IDS` → `200`, ignored and logged.
  4. Nonce missing, expired, or its user ≠ `user_id` → `200`, nonce marked `rejected`.
  5. In one transaction: lock the user row, count today's `rewarded_ad` rows; at the cap → nonce
     `capped`; else post `rewarded_ad:<transaction_id>` for `adRewardCredits` → nonce `granted`.
     A replayed `transaction_id` is a no-op. Always `200` once the signature is valid, so AdMob
     stops retrying.
- `GET /rewards/ads/session/{nonce}` (signed in, own nonce) →
  `{status: pending|granted|capped|rejected, credits?, balance}`.

## 15. Account deletion

Shared routine `deleteAccount(userId, actor)`, one transaction: revoke every session and refresh
token; post `account_deleted` for the whole balance (if > 0); null `email`, `googleSub`,
`username`, `referralCode`, `phone`, `displayName`, `avatarUrl`; status `deleted`, `deletedAt`
now; `Device.userId` null for its installs. Ledger rows and `Referral` rows keep the now-anonymous
user id; `BonusClaim` rows are untouched. Audited as `user.deleted`.

- App: `DELETE /me {"confirm": "DELETE"}` → `200 {deleted: true}`.
- Web (Play requirement): `POST /account-deletion/start {email}` (always
  `200 {sentTo}`; a code is sent only if an account exists), then
  `POST /account-deletion/confirm {email, code}` → `200 {deleted: true}`. Same OTP rules, purpose
  `delete_account`, per-IP limits.
- `GET /account-deletion` (outside `/api`) serves one self-contained HTML page (inline CSS and
  script, strict CSP) running those two steps. This URL goes in the Play Console.

## 16. App API summary (`/api/app/v1`)

| Method | Path | Auth |
|---|---|---|
| POST | `/devices` | none (exists) |
| POST | `/auth/google`, `/auth/email/start`, `/auth/email/verify`, `/auth/refresh`, `/auth/logout` | none |
| GET | `/me` | user |
| POST | `/me/claim` | user |
| PATCH | `/me/username` | user |
| DELETE | `/me` | user |
| GET | `/usernames/{name}/availability` | user |
| POST | `/credits/quote` | user |
| GET | `/credits/history?cursor=&limit=` | user |
| POST | `/rewards/ads/session` | user |
| GET | `/rewards/ads/session/{nonce}` | user |
| GET | `/rewards/admob/ssv` | AdMob signature |
| POST | `/captions` · GET `/captions/{jobId}` | user (changed) |
| POST | `/account-deletion/start`, `/account-deletion/confirm` | none |

`GET /me` → `{id, email, username, referralCode, creditBalance, accountStatus, needsClaim,
signInMethods: {google, email}, ads: {rewardCredits, dailyCap, remainingToday}}`.

New error codes: `SIGN_IN_REQUIRED` 401, `DEVICE_NOT_REGISTERED` 422, `GOOGLE_TOKEN_INVALID` 401,
`GOOGLE_EMAIL_UNVERIFIED` 422, `SIGN_IN_METHOD_UNAVAILABLE` 503, `EMAIL_DOMAIN_NOT_ALLOWED` 422,
`ACCOUNT_LINK_CONFLICT` 409, `OTP_INVALID` 422, `OTP_EXPIRED` 422, `OTP_ATTEMPTS_EXCEEDED` 429,
`OTP_RESEND_TOO_SOON` 429, `USERNAME_INVALID` 422, `USERNAME_TAKEN` 409, `ALREADY_CLAIMED` 409,
`REFERRAL_CODE_INVALID` 422, `INSUFFICIENT_CREDITS` 402, `ACCOUNT_SUSPENDED` 403,
`INVALID_AUDIO` 422, `AD_DAILY_CAP_REACHED` 409. `RATE_LIMITED` (exists) gains
`details.retryAfterSeconds`. `BONUS_ALREADY_CLAIMED` and `IP_LIMIT_REACHED` are claim *reasons*,
not errors.

## 17. Admin API (`/api/admin/v1`)

New permissions: `users.read` (viewer and up), `users.manage` (admin and up), `credits.manage`
(owner). Every write is audited.

| Method | Path | Permission |
|---|---|---|
| GET / PUT | `/credit-settings` | credits.manage |
| GET / POST | `/pricing-rules?feature=` | credits.manage |
| POST | `/pricing-rules/{id}/activate` | credits.manage |
| GET | `/credits/reconciliation` | credits.manage |
| GET | `/users?q=&cursor=` (email or username) | users.read |
| GET | `/users/{id}`, `/users/{id}/ledger?cursor=` | users.read |
| POST | `/users/{id}/adjustments {amount, reason}` | users.manage |
| POST | `/users/{id}/suspend {reason}`, `/users/{id}/unsuspend` | users.manage |
| DELETE | `/users/{id} {reason}` | users.manage |
| GET | `/stats/credits?days=30` → per day and type: granted and spent | users.read |

An adjustment that would take a balance below zero is refused with `422` and the current balance.
Adjustments, suspension and deletion all require a `reason`, which goes into the audit entry.

## 18. Security and privacy notes

- Stored identifiers: email (account), Google `sub`, the install's device-token hash, HMACs of the
  canonical email and install id (`BonusClaim`), HMACs of IPs in short-lived Redis counters. No
  Android ID, no raw IPs on accounts, no OTP in plaintext.
- For the owner's Play Console and privacy policy: email address (account management), "Device or
  other IDs" = the app's install ID (fraud prevention), the advertising ID collected by the AdMob
  SDK, account deletion in the app and at `/account-deletion`, and the one-way hashes kept after
  deletion to prevent repeat bonuses.

## 19. Milestones (one branch, `feat/accounts-credits`)

The whole schema in §6 ships as **one migration in milestone 1**, so the owner runs
`prisma migrate deploy` once; later milestones add no schema.

1. **Accounts:** config, the migration, rate limiter, email sender,
   OTP, Google verifier, tokens and guard, sign-in endpoints, `/me`, username, claim stub
   (username only, no credits yet), deletion (app, web, page). Doc: sign-in and account sections.
2. **Credits:** ledger, settings and pricing services, quote, history, paid WAV captions with
   refunds, bonus and anti-abuse, referrals, reconciliation, `docs/app-api/auto-caption.md` folded
   in. Doc: credits and captions sections.
3. **Rewarded ads:** verifier, sessions, callback, poll. Doc: ads section with the AdMob SSV setup.
4. **Admin API:** settings, pricing rules, users, stats, reconciliation, permissions.

## 20. Testing

All with mocks and local fakes, as today; nothing touches Neon or a live provider.
- Concurrent charges cannot overdraw (parallel `post` calls against the guarded update; the fake
  applies the `WHERE` condition atomically; plus the `CHECK` constraint pinned in the migration).
- Idempotent grants: ad `transaction_id`, referral, job key.
- Refund on a failed job (refusal, last attempt, no provider); none on a retryable first failure.
- Pricing tier boundaries (exactly 60 s, just over, open-ended last tier, per-job).
- Server-measured WAV duration wins over the client's; malformed, non-PCM and truncated WAVs.
- SSV: valid signature, tampered query, unknown key (refetch once), foreign ad unit, replay, cap.
- Bonus eligibility across delete-and-recreate, a second account on one install, canonical email
  (`+tag`, Gmail dots), the soft IP limit.
- OTP expiry, attempts, resend cooldown, per-email/install/IP limits.
- Refresh rotation and reuse detection; logout; a deleted user's tokens fail at once.
- A suspended user cannot spend, start an ad session or claim.
- Google: wrong audience, unverified email, link to an existing email account, link conflict.

## 21. Rollout (owner)

1. `.env`: `USER_JWT_SECRET`, `IDENTITY_HMAC_SECRET`, `GOOGLE_CLIENT_IDS`, SMTP settings,
   `ADMOB_AD_UNIT_IDS`, `TRUST_PROXY` (when behind nginx).
2. Google Cloud: an **Android** OAuth client (package name + SHA-1) and a **Web** OAuth client; the
   app passes the Web client ID as its server client ID; that ID goes in `GOOGLE_CLIENT_IDS`.
3. AdMob: on each rewarded ad unit, set the SSV callback URL to
   `https://<server>/api/app/v1/rewards/admob/ssv`.
4. `npx prisma migrate deploy`.
5. Admin: create and activate a pricing rule for `auto_captions` (captions answer 503 until then).
6. Play Console: privacy policy link, Data safety answers (§18), account deletion URL
   `https://<server>/account-deletion`.
