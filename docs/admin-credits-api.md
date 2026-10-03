# SlimShot admin API: app users and credits

The routes the admin dashboard uses to manage app users, credit amounts, Auto caption pricing
and the ledger check. The dashboard screens for them are built from this file.

## Basics

- **Base URL:** `https://<server>/api/admin/v1`.
- **Auth:** the dashboard's existing admin access token, `Authorization: Bearer <token>`.
- **Envelope:** `{ "success": true, "data": … }` or
  `{ "success": false, "error": { "code", "message", "details"?, "traceId" } }`. Branch on `code`.
- **Every write is audited** (Audit log page) with the admin's id and, where a reason is
  required, the reason.
- Dates are ISO 8601 strings in UTC.

### Permissions

| Permission | Roles | Allows |
|---|---|---|
| `users.read` | viewer, editor, admin, owner | Find and view users, their ledger, credit stats |
| `users.manage` | admin, owner | Adjust credits, suspend, unsuspend, delete users |
| `credits.manage` | owner | Credit settings, pricing rules, the balance check |

The dashboard should hide what the signed-in role cannot do. The server enforces it anyway.

### Errors common to every route

| Status | `code` | When |
|---|---|---|
| 401 | `UNAUTHENTICATED` | Missing, expired or invalid admin token. Refresh once, then sign in. |
| 403 | `FORBIDDEN` | The role lacks the route's permission. |
| 422 | `VALIDATION_FAILED` | A field is missing or out of range. `details` lists the messages, e.g. `["amount should not be equal to 0"]`. |

## 1. Credit settings

One record holding every amount, cap and limit. Changes apply within 30 seconds.

### `GET /credit-settings` (`credits.manage`)

```json
{
  "id": "default",
  "signupBonusCredits": 100,
  "adRewardCredits": 5,
  "adDailyCap": 10,
  "referralInviterCredits": 20,
  "referralInviteeCredits": 20,
  "referralCapCount": 10,
  "referralCapDays": 30,
  "ipSignupLimitPer24h": 10,
  "disposableEmailDomains": ["mailinator.com", "…"],
  "otpMaxAttempts": 5,
  "otpResendCooldownSeconds": 60,
  "otpPerEmailPerHour": 5,
  "otpPerDevicePerHour": 10,
  "otpPerIpPerHour": 20,
  "updatedById": "admin id or null",
  "updatedAt": "2026-10-04T09:00:00.000Z"
}
```

### `PUT /credit-settings` (`credits.manage`)

Send only the fields to change; the response is the whole record after the change. Unknown
fields are refused with 422.

| Field | Meaning | Allowed |
|---|---|---|
| `signupBonusCredits` | Credits on claiming an account (once per email and per install) | 0–100000 |
| `adRewardCredits` | Credits per completed rewarded ad | 0–100000 |
| `adDailyCap` | Rewarded ads per user per UTC day | 0–1000 |
| `referralInviterCredits` | Credits to the person who invited | 0–100000 |
| `referralInviteeCredits` | Credits to the person invited | 0–100000 |
| `referralCapCount` | Rewarded referrals per inviter… | 0–10000 |
| `referralCapDays` | …within this many days | 1–365 |
| `ipSignupLimitPer24h` | New accounts per IP per 24 h before bonuses stop | 1–100000 |
| `disposableEmailDomains` | Domains refused at email sign-in. Trimmed, lowercased, de-duplicated | up to 5000 domain names |
| `otpMaxAttempts` | Wrong code entries before the code is void | 1–20 |
| `otpResendCooldownSeconds` | Wait between code emails to one address | 0–3600 |
| `otpPerEmailPerHour` | Code emails per address per hour | 1–10000 |
| `otpPerDevicePerHour` | Code emails per install per hour | 1–10000 |
| `otpPerIpPerHour` | Code emails per IP per hour | 1–10000 |

## 2. Auto caption pricing

Pricing is versioned. A rule is never edited: to change a price, create a new version and
activate it. Exactly one version per feature is active; until one is, the app's Auto caption
answers `503 CAPTIONS_UNAVAILABLE`. Features today: `auto_captions`.

A rule is one of two modes:
- `per_job`: every job costs `perJobCredits`.
- `duration_tiers`: the job costs the first tier whose `upToSeconds` is at least the audio's
  length (inclusive: exactly 60 s is "up to 60"). The last tier has `upToSeconds: null` and
  covers everything longer.

A rule as returned:

```json
{
  "id": "clx…",
  "feature": "auto_captions",
  "version": 3,
  "mode": "duration_tiers",
  "perJobCredits": null,
  "tiers": [{ "upToSeconds": 60, "credits": 2 }, { "upToSeconds": 300, "credits": 5 }, { "upToSeconds": null, "credits": 10 }],
  "isActive": true,
  "note": "October prices",
  "createdById": "admin id",
  "createdAt": "…",
  "activatedAt": "…"
}
```

### `GET /pricing-rules?feature=auto_captions` (`credits.manage`)

Every version of the feature, newest first. An unknown or missing `feature` → 422.

### `POST /pricing-rules` (`credits.manage`) → `201`

```json
{ "feature": "auto_captions", "mode": "duration_tiers", "tiers": [{ "upToSeconds": 60, "credits": 2 }, { "upToSeconds": null, "credits": 5 }], "note": "optional, ≤ 500 chars" }
```
or `{ "feature": "auto_captions", "mode": "per_job", "perJobCredits": 3 }`.

Returns the new rule: the next version, **inactive**. Field limits: `credits` and
`perJobCredits` 0–100000; `upToSeconds` 1–86400 or `null`; 1–50 tiers.

Beyond field limits, the tiers must make sense together. Otherwise `422 VALIDATION_FAILED`
with `details.problems`, a list of sentences to show as they are:
- the last tier must be open-ended (`null`), and only the last;
- each `upToSeconds` must be greater than the one before;
- a `per_job` rule needs `perJobCredits`.

### `POST /pricing-rules/{id}/activate` (`credits.manage`) → `200`

Makes this version the one that prices new jobs and switches the previous one off, in one
step. Jobs already charged keep their price. Activating the active rule changes nothing.
Returns the feature's rules (as the list route). Unknown id → `404 NOT_FOUND`. Two activations
at the same moment can answer `409 CONFLICT` to one of them; reload and retry.

## 3. Balance check

### `GET /credits/reconciliation` (`credits.manage`)

Every user's balance should equal the sum of their ledger entries. The server checks this daily
and logs any difference to the audit log (`credits.reconcile.mismatch`). This route runs the
check now.

```json
{ "mismatches": [{ "userId": "…", "cached": 40, "ledger": 35 }] }
```

An empty list means the books balance. A non-empty list is a bug to report; the server never
corrects it on its own.

## 4. App users

These are people signed in to the mobile app, not dashboard admins.

A **summary**:

```json
{
  "id": "…",
  "email": "ada@example.com",
  "username": "ada",
  "accountStatus": "active",
  "creditBalance": 120,
  "createdAt": "…",
  "claimedAt": "… or null (has not picked a username yet)"
}
```

`accountStatus` is `active`, `suspended` (can sign in and read, cannot spend, watch ads for
credits or claim a bonus) or `deleted` (personal data erased: `email` and `username` are `null`).

### `GET /users?q=&cursor=&limit=` (`users.read`)

Newest first. `q` matches any part of the email or username, ignoring case; leave it out to
list everyone. `limit` 1–100, default 20. → `{ "items": [summary…], "nextCursor": "… or null" }`.
Pass `nextCursor` as `cursor` for the next page.

### `GET /users/{id}` (`users.read`)

The summary plus:

```json
{ "referralCode": "ADA123", "deletedAt": null, "signInMethods": { "google": true, "email": true } }
```

Unknown id → `404 NOT_FOUND`.

### `GET /users/{id}/ledger?cursor=&limit=` (`users.read`)

The user's credit history, newest first, same paging as the list:

```json
{ "items": [{ "id": "…", "type": "rewarded_ad", "amount": 5, "balanceAfter": 125, "createdAt": "…" }], "nextCursor": null }
```

`type` is one of `signup_bonus`, `referral_inviter`, `referral_invitee`, `rewarded_ad`,
`feature_charge` (negative), `feature_refund`, `admin_adjustment`, `account_deleted`
(negative: the balance forfeited on deletion), `purchase` (reserved).

### `POST /users/{id}/adjustments` (`users.manage`) → `200`

```json
{ "amount": -20, "reason": "Duplicate reward after support ticket #812" }
```

`amount` is a whole number, not 0, from −1000000 to 1000000; positive adds credits. `reason` is
3–500 characters and goes into the audit entry. → `{ "balance": 100 }`, the new balance.

- Would take the balance below zero → `422 VALIDATION_FAILED`, message "This would take the
  balance below zero.", `details: { "balance": 12 }`.
- Unknown or deleted user → `404 NOT_FOUND`.
- Adjusting a suspended user is allowed.
- Each request is a new entry: do not resend on a timeout without checking the ledger first.

### `POST /users/{id}/suspend` (`users.manage`) → `200`

`{ "reason": "Ad reward abuse" }` (3–500 characters). → the user's detail. The user stays
signed in but cannot spend, earn from ads or claim. Already suspended or deleted →
`409 CONFLICT`; unknown → `404`.

### `POST /users/{id}/unsuspend` (`users.manage`) → `200`

No body. → the user's detail. Not suspended → `409 CONFLICT`; unknown → `404`.

### `DELETE /users/{id}` (`users.manage`) → `200`

`{ "reason": "Asked by email on 2026-10-02" }` (3–500 characters). The same deletion as the
user's own: signs out every install, forfeits the balance, erases email, username and Google
link, and keeps only the anonymous ledger and the anti-abuse hashes. Cannot be undone.
→ `{ "deleted": true }`. Unknown or already deleted → `404`.

## 5. Credit stats

### `GET /stats/credits?days=30` (`users.read`)

Credits granted and spent per UTC day and entry type, for the last `days` days including today
(1–365, default 30). Days and types with no entries are absent, so the chart fills gaps with 0.

```json
[
  { "day": "2026-10-03", "type": "rewarded_ad", "granted": 250, "spent": 0 },
  { "day": "2026-10-03", "type": "feature_charge", "granted": 0, "spent": 180 }
]
```

`granted` sums the positive entries and `spent` the negative ones, shown as a positive number.
