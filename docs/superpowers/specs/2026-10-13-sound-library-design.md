# Sound library — Design

Date: 2026-10-13. Repos: `slimshot_server`, `slimshot-admin`. Branches: `feat/sound-library`
in both, built on `feat/r2-storage` (Cloudflare R2 storage, not yet merged).

Source: the app developer's brief (catalogue for the editor's "Sound effects" sheet), adapted
by the owner to the move from Cloudinary to R2 and to the app's actual row design. Where this
spec and the brief differ, this spec wins.

## 1. Purpose

The Android editor gets a "Sound effects" sheet: category pills across the top, then rows of
**cover · title · duration · download icon**. Tapping download saves the original file on the
device, after which the app adds it to the timeline from its own library. No sign-in: everyone
can browse and download. Music will use the same catalogue later, under a sibling root.

The server serves that catalogue; the dashboard lets the owner organise sounds into
categories and give them covers.

## 2. Decisions

| Decision | Choice | Why |
|---|---|---|
| Storage | **One public R2 bucket** (`slimshot-audio`, custom domain `cdn.techfamz.com`) holds originals and covers | Owner's choice: everything in the catalogue is free and public. Gating downloads later would need moving originals to a private bucket. |
| Previews | **None.** No preview files, no transcoding, no `FileRole.preview` rows | The app shows cover, name and download; there is no in-app listening before download. |
| Download URL | The original's public CDN URL, returned only by `POST …/download`, presented to the app as short-lived (`expiresAt` = now + 10 min) | Fast and edge-cached today; telling the app not to store it keeps the option to switch to signed URLs without an app change. |
| List order | Newest first: `publishedAt desc, id desc` | No per-category ordering field exists; newest-first needs no schema change. |
| Category at upload | One picker for the whole upload batch | Packs are uploaded into one category; a per-row picker was tried and removed before (R9e). |
| Cover at upload | Not in this version. Covers are added on the sound's page after upload | Keeps the upload drawer unchanged apart from the category picker. |
| Schema | **No change** | `Asset.categoryId`, `Category.kind`, `FileRole.thumbnail`, `UploadSession.role` already exist. |

## 3. Category convention

The app finds its pills by one fixed rule: the top-level **audio** category with slug
`sound-effects` (later a sibling `music`). Its **active** children, in `sortOrder`, are the
pills. Everything else about categories (names, nesting, order, visibility) is managed in the
dashboard and is never hardcoded in the server or the app.

The owner must create the `sound-effects` category (audio, top level) in the dashboard before
the app shows anything. Until then the categories endpoint answers 404.

## 4. Public catalogue API (app)

Route prefix `api/app/v1/catalog`. No authentication. Envelope as everywhere else:
`{ success: true, data, meta? }` / `{ success: false, error: { code, message, details?, traceId } }`.

### 4.1 `GET /catalog/categories?kind=audio&root=sound-effects`

- `kind` (required, an `AssetKind`), `root` (required, a slug).
- The root is the category with that `kind` and `slug`, `parentId = null`, `isActive = true`;
  otherwise **404 `NOT_FOUND`**.
- Returns the root's active children in `sortOrder` (then name), each with its active children
  nested the same way: `{ id, slug, name, children: [...] }`. Inactive categories and their whole
  subtree are left out.

### 4.2 `GET /catalog/assets?kind=audio&category=<slug>&cursor=&limit=`

- `kind` required. `category` optional: when given, it must be an active category of that kind
  (otherwise **404 `NOT_FOUND`**), and the list covers that category plus its active
  descendants. Passing the root slug (`sound-effects`) lists every sound effect. Omitted: every
  listed asset of the kind.
- Listed = `status = published`, `deletedAt = null`, `visibility = public`.
- Order newest first (`publishedAt desc, id desc`). `limit` 1–50, default 30. `cursor` is the
  last item's `id` from the previous page; `meta.nextCursor` is `null` on the last page. Paging
  is keyset (`publishedAt`, `id`), so sounds published mid-scroll never duplicate or skip rows.
  A cursor that is not a listed asset of this kind is **422 `VALIDATION_FAILED`**.
- Item:
  ```json
  {
    "id": "…", "slug": "ui-button-3f9a2c1d", "title": "UI Button", "author": "SlimShot",
    "durationMs": 412,
    "category": { "slug": "ui", "name": "UI" },
    "cover": { "url": "https://cdn.techfamz.com/slimshot/covers/….png" }
  }
  ```
  `category` is `null` when the asset has none (only possible when `category` is omitted);
  `cover` is `null` when there is no cover. The original's URL is never in a list.

### 4.3 `POST /catalog/assets/:id/download`

- The asset must be listed-or-unlisted (`published`, not deleted, `visibility != private`);
  otherwise **404 `NOT_FOUND`** (unknown, unpublished, deleted and private look the same).
- **Entitlement checkpoint:** one function, `canDownload(asset)`, returns `true` today. Gating
  later (sign-in, credits) changes that function only.
- Increments `Asset.downloadCount` atomically.
- Returns `{ url, expiresAt, filename, format, byteSize, durationMs }`: `url` is the original's
  CDN URL, `expiresAt` is now + 10 minutes, `filename` is `<slug>.<format>`.
- Not cached.

### 4.4 Rate limits and caching

- Per client IP (`req.ip`, nginx-trusted), via `core/rate-limit`: reads (categories + assets)
  **120 per minute**, downloads **30 per minute**. Over the limit: **429 `RATE_LIMITED`** with
  `details.retryAfterSeconds`.
- Reads are cached in Redis with `CacheService.wrap` under the generation namespace
  `catalog:<kind>` for 5 minutes. The generation is bumped (`bumpGeneration`) on: publish,
  unpublish, asset update (any field, including category), soft delete, cover set or removed,
  and every category create, update, reorder and delete. Bumping happens whatever the asset's
  status, so the rule stays simple and cannot miss a case.
- A Redis outage must not take the catalogue down: reads fall through to the database
  (`CacheService.wrap` already does this) and the catalogue's rate-limit check lets the request
  through when Redis cannot be reached (fail-open). Only a real "over the limit" answer is a
  429. Other routes' limiter behaviour is unchanged.

## 5. Admin API changes

### 5.1 Category assignment

- `PATCH /api/admin/v1/assets/:id` accepts `categoryId: string | null`. A string must be an
  existing category whose `kind` equals the asset's kind (**422 `VALIDATION_FAILED`** with a
  message otherwise); `null` clears it. Categories are hard-deleted and deletion refuses while
  assets use them, so "exists" covers "not deleted". Inactive categories may be assigned.
- `POST /api/admin/v1/assets/upload-ticket` accepts optional `categoryId`, validated the same
  way, set on the new draft asset.
- `GET /api/admin/v1/assets` accepts `categoryId`: that category and all its descendants
  (active or not; the dashboard filter is for the owner).

### 5.2 Admin asset view

`GET /assets` and `GET /assets/:id` (and the PATCH/publish/unpublish responses) keep every
field they return today and add: `status`, `visibility`, `categoryId`, `createdAt`,
`publishedAt`, and `files.thumbnail` / `files.original` as `{ url, byteSize, format,
durationMs? }`. The admin view may include the original; the public catalogue never does.

### 5.3 Covers

- **Ticket:** `POST /assets/upload-ticket` with `role: "thumbnail"` and `assetId` (required for
  that role; `kind`, `title`, `author`, `categoryId` are ignored). The asset must exist and not
  be deleted. Declared type must be `image/jpeg`, `image/png` or `image/webp`; size ≤
  `UPLOAD_COVER_MAX_BYTES` (env, default 5 MB). Key: `slimshot/covers/<uuid>.<ext>`. No new
  asset is created; the session records `role = thumbnail` and the asset id.
- **Upload:** the same presigned R2 PUT as audio (signed type, length, `If-None-Match: *`).
- **Finalize:** `POST /assets/finalize` branches on the session's role. For a thumbnail it reads
  the first bytes back and checks the signature: JPEG `FF D8 FF`, PNG `89 50 4E 47 0D 0A 1A 0A`,
  WebP `RIFF????WEBP`. Content that is not one of those, or differs from the declared type, or is
  over the cap, is refused and the object deleted (same rules as audio). On success, in one
  transaction the previous thumbnail `AssetFile` rows of the asset are removed and the new one
  created; after the commit the previous objects are deleted from R2 (best effort, a failure is
  logged, never surfaced). The asset's status is not changed. Catalogue cache bumped. Audited.
- **Remove:** `DELETE /api/admin/v1/assets/:id/cover` removes the thumbnail row(s) and their
  objects; 404 if the asset is unknown; 204 whether or not a cover existed. Cache bumped, audited.
- Permissions: ticket and finalize keep `asset.create`; cover removal uses `asset.update`.

### 5.4 Storage adapter

`verifyUpload(key)` today always probes audio. It becomes `verifyUpload(key, inspect)`, where
`inspect(stream, size)` returns `{ format, mimeType, durationMs? }`; ingest passes `probeAudio`
for originals and `probeImage` for covers. `probeImage` reads only what it needs and throws
`UnreadableUploadError` for content that is not a supported image.

## 6. Dashboard

- **Sound page** `/assets/[id]` (new, same skeleton/loading conventions as the user page):
  title and author fields, category picker, save; cover panel (image, Add / Replace / Remove,
  upload through the ticket → PUT → finalize flow with `role: "thumbnail"`); status pill with
  Publish / Unpublish; duration and file size. Rows in the asset list (table and cards) link to
  it.
- **Category picker** (shadcn `Select`): the kind's real tree, each option indented by depth,
  plus "No category". Used on the sound page, in the upload drawer (one picker for the batch,
  sent as `categoryId` on every ticket) and as the asset list's category filter.
- **Asset list:** the category filter works (sent to the server, descendants included) and the
  "isn't supported by the API yet" notice is removed. `Artwork` shows the cover image when the
  asset has one and keeps the gradient tile otherwise.
- Mutations through `useMutation`; loading states are skeletons; dark-only shadcn/Radix styling.

## 7. Contract doc for the app

`slimshot_server/docs/app-catalog-api.md`, written for the Flutter developer, complete enough to
build against alone: each endpoint with request and response JSON, the error codes and statuses,
paging rules, caching (what is cached, for how long, what makes changes appear), rate limits,
the `sound-effects` root convention, the download flow (call download, fetch `url` immediately,
save the file, never store the URL), the fallback tile when `cover` is null, and what the app
must not rely on (URL shapes, the URL staying valid past `expiresAt`, list order beyond
newest-first, field order, any field not documented).

## 8. Errors

| Situation | Status | Code |
|---|---|---|
| Unknown root / category slug, or inactive | 404 | `NOT_FOUND` |
| Unknown, unpublished, deleted or private asset on download | 404 | `NOT_FOUND` |
| Bad `kind`, `limit`, unknown `cursor` | 422 | `VALIDATION_FAILED` |
| Rate limit exceeded | 429 | `RATE_LIMITED` |
| Admin: `categoryId` of another kind / unknown | 422 | `VALIDATION_FAILED` |
| Admin: cover not an image / over the cap / type mismatch | 400 | (as audio refusals today) |

## 9. Testing

- Server (Jest): unit specs for the catalogue service (published-only, private/unlisted/
  deleted excluded, original never listed, category + active descendants, inactive excluded,
  paging and cursor, ordering), `canDownload`, the download counter, `probeImage` (byte-built
  JPEG/PNG/WebP and a non-image), cover finalize (replace, delete old object, refusals), category
  validation on update and ticket, admin list filter, cache bumps on every listed trigger; HTTP
  specs for the three public endpoints (envelope, 404s, 422s, 429 via a stub limiter, cache
  hit path) and the cover delete route.
- Dashboard (Vitest): category picker (indentation, "No category", value), upload drawer sends
  `categoryId`, list filter sends `categoryId` and the notice is gone, sound page edit/save,
  cover add/replace/remove flow, `Artwork` with and without a cover.
- All existing suites stay green; lint and typecheck clean in both repos.

## 10. Out of scope

Previews and transcoding; search; favourites; tags; collections; device registration; a cover
picker in the upload drawer; private storage or signed download URLs; uploading the sound
files themselves (the owner does that).

## 11. Licensing note

Only sounds whose licence allows redistribution inside an app may be published. Files named
`ES_…` (Epidemic Sound) are not redistributable. The other candidates in `../slimshot_Audio`
came without licence files; packs such as Epic Stock Media and SoundCrib must have their
licence checked before publishing.
