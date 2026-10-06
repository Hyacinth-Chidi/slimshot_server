# Brief: accounts and credits on slimshot_server

You are working in `slimshot_server` (NestJS, Prisma on Postgres, Redis, BullMQ). Build the
**app-user accounts and credits system** that the SlimShot Android app (Flutter) will use. This
brief is the agreed product design; plan from it, ask me only where it is genuinely ambiguous,
and build it test-first. Payments are **out of scope** (they come next), but the design must
leave room for them.

## What exists today (read it before planning)

- **Admin auth** (`src/modules/auth`): admin login, JWT, refresh tokens. App users must get
  their **own** auth — separate secret and audience — never the admin tokens.
- **Devices** (`src/modules/devices`): `POST /api/app/v1/devices` registers an install and
  returns an anonymous device token (stored hashed in `Device`). The app sends it today.
- **Captions** (`src/modules/captions`): `POST /api/app/v1/captions` (multipart field `audio`,
  a mono 16 kHz WAV; optional `language`; header `Idempotency-Key`) and
  `GET /api/app/v1/captions/:jobId`. Jobs live in Redis, a worker calls the transcription
  provider, a sweeper expires results. **A key names one upload**: the same key answers with
  the same job; the app takes a fresh key only after a job that *failed*.
- **`User` and `UserEntitlement`** exist in `prisma/schema.prisma` as unused stubs. `AuditLog`
  exists. Responses use the envelope `{success, data}` / `{success:false, error:{code, message,
  traceId}}` — keep it.

## The product, in one paragraph

The app is free and works fully without an account. Some features cost **credits**; the first
is auto captions. Tapping Auto captions while signed out shows a sign-in sheet. Signing in is
**Google** or **email with a one-time code** — no passwords, and the first sign-in creates the
account. A new account then chooses a **username** and claims **100 free credits** (amount set
by the admin). When credits run out, the user can watch a **rewarded ad** for credits (amount
set by the admin), or **invite a friend** with a code so both earn credits. Users can **delete
their account** from Settings. Every price, amount and limit is set in the admin panel; nothing
is hard-coded.

## Requirements

### 1. Sign-in

- **Google**: verify the ID token server-side (audience from config). Store the Google `sub`.
- **Email one-time code**: 6 digits, stored hashed, valid 10 minutes, at most 5 attempts per
  code, resend cooldown 60 s, rate-limited per email, per device and per IP. Email delivery
  goes through a pluggable sender (configured, not hard-coded); in development, log the code.
- **One account per verified email.** Google and email sign-in with the same address land on
  the same account (link the Google `sub`).
- **Tokens**: short-lived access JWT (about 15 min) and a rotating refresh token (about 30
  days, stored hashed). Reuse of a rotated refresh token revokes that token family. Logout
  revokes. Endpoints for sign-in, refresh, logout and `GET /me`.
- The sign-in request carries the app's **device token** and the device's **Android ID**, so
  the server can link the install to the account and apply the per-device rules below. Store
  device identifiers only as HMACs with a server secret.
- Account status `active | suspended | deleted`. A suspended user cannot spend credits.

### 2. Username

- Unique (case-insensitive), 3–20 characters, `a–z 0–9 _`, with a reserved list. An
  availability check endpoint for live validation. **Private for now**: shown only to the user.
- Set on the claim step; changeable later with the same rules.

### 3. The credit ledger

- **Integers only.** An append-only **ledger** of transactions: user, signed amount, type
  (`signup_bonus`, `referral_inviter`, `referral_invitee`, `rewarded_ad`, `feature_charge`,
  `feature_refund`, `admin_adjustment`, and `purchase` reserved for payments), a reference (job
  id, ad transaction id, referral id, admin id), metadata, timestamp. The balance is the sum;
  cache it on the user, updated **in the same database transaction** as the ledger row.
- **Never negative, even under concurrency**: two simultaneous charges must not overdraw.
- Idempotent grants: the same ad transaction, referral or job can never be credited or charged
  twice.
- A periodic check that each cached balance equals its ledger sum.

### 4. Pricing (admin-set) and charging captions

- Pricing rules per feature (`auto_captions` first): either **per job**, or **tiers by
  duration** (e.g. up to 60 s → 2 credits, up to 180 s → 5, …, last tier open-ended). Rules are
  versioned; changing one never rewrites past charges.
- `POST /api/app/v1/credits/quote {feature, durationSeconds}` → `{credits, balance, enough}`,
  so the app shows "This will use 6 credits · You have 94" **before** the user generates.
- Captions now **require a signed-in user** (`401 SIGN_IN_REQUIRED` for an anonymous device).
- On job creation, measure the uploaded audio's real duration from the WAV header (never trust
  the client), price it, and **hold** the credits atomically with the balance check — `402
  INSUFFICIENT_CREDITS {required, balance}` before any provider call. **A failed job is
  refunded** automatically. The existing Idempotency-Key rule carries over: the same key never
  charges twice.

### 5. Signup bonus and anti-abuse

- The bonus is granted when the user claims it (username set), **once per verified email and
  once per device** (device token + Android ID). Keep the claim records — email and device
  HMACs only — **after account deletion**, so delete-and-recreate earns nothing.
- Block disposable email domains (list editable in admin).
- **No one-account-per-IP rule** (mobile carriers put thousands of phones behind one IP).
  Instead, a soft limit of N new accounts per IP per 24 h, N set in admin.
- An ineligible claim still creates the account and returns a clear reason
  (`BONUS_ALREADY_CLAIMED`) with zero credits.

### 6. Referrals

- Each user gets a short referral code (not the username). A new user can enter a code on the
  claim step. Inviter and invitee each get credits (both amounts set in admin) **only when the
  invitee is eligible for the signup bonus** (new email and new device) — so self-referral with
  a second account on the same phone earns nothing. A cap on rewarded referrals per inviter per
  period, set in admin. No self-referral, and no chains.

### 7. Rewarded ads (AdMob server-side verification)

- A callback endpoint for AdMob server-side verification. Verify the ECDSA signature against
  Google's published verifier keys (cached). The app sets the SSV `user_id` and passes a
  server-issued nonce as `custom_data`.
- Grant the reward amount (set in admin, default 5) **once per AdMob `transaction_id`**, up to
  a daily cap per user (set in admin, default 10). Never grant from an app request alone.
- An endpoint the app polls after the ad closes, to learn whether the reward landed.

### 8. Account deletion

- `DELETE /api/app/v1/me` (signed in), with a confirmation step. Revoke all tokens, delete
  personal data (email, username, Google link), forfeit credits, keep ledger rows only in
  anonymised form. Keep the bonus-claim HMACs (anti-fraud).
- Google Play also requires a **web** way to request deletion: endpoints for an email →
  one-time code → confirm flow, which a small web page can call.

### 9. Admin

- Settings: signup bonus, ad reward and daily cap, referral amounts and cap, IP sign-up limit,
  disposable domains, OTP limits, pricing rules (create, version, activate).
- Users: search by email or username, view balance and ledger, grant or deduct credits with a
  reason, suspend, unsuspend, delete.
- Stats: credits granted and spent per day, by type.
- Every admin action goes to `AuditLog`.

### 10. Tests that must exist

Concurrent charges cannot overdraw; idempotent grants (ad transaction, referral, job key);
refund on a failed job; pricing tier boundaries; server-measured duration wins over the
client's; SSV signature verification (valid, tampered, unknown key); bonus eligibility across
delete-and-recreate and across a second account on one device; the soft IP limit; OTP expiry,
attempt and resend limits; refresh-token rotation and reuse detection; a suspended user cannot
spend.

## Deliverables

1. A written plan first (data model, endpoints, error codes, migrations), then the build,
   test-first, in focused commits on a branch. Do not push or merge — I test first.
2. **`docs/app-credits-api.md` in the server repo**: the exact contract for the app — every
   endpoint, request, response, error code, and the AdMob SSV setup (what the app must set). The
   app-side work will be built from this file, so keep it exact and current.
3. A short note of anything you decided that this brief did not settle.
