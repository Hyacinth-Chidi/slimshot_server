# Sound catalogue API (for the app)

The contract for the editor's **Sound effects** sheet: category pills, then rows of
**cover · title · duration · download**. Build against this document alone. Anything it does
not promise, don't rely on.

- **Base URL:** `https://slimshot-server.techfamz.com/api/app/v1/catalog`
- **Auth:** none. Everyone can browse and download. Send no `Authorization` header.
- **Format:** JSON, camelCase. Times are ISO 8601 in UTC.
- **There are no previews.** A sound is only playable after it has been downloaded.

## 1. The `sound-effects` root

The app finds its pills by one fixed rule. It asks for the children of the top-level **audio**
category whose slug is `sound-effects`. Those children, in the order returned, are the pills.

- This is the only slug the app hardcodes. Names, order, nesting and which pills are visible
  are all managed in the dashboard and can change at any time.
- Music will later use a sibling root, `music`, with the same endpoints.
- A pill can have sub-categories (`children`). Listing a pill includes the sounds of all its
  sub-categories.
- To show **every** sound effect (an "All" pill, if you want one), list the root itself:
  `category=sound-effects`.

## 2. Responses

Success:

```json
{ "success": true, "data": …, "meta": { … } }
```

`meta` appears only on paged lists.

Error (every endpoint):

```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "No category \"sound-effects\" for audio.",
    "traceId": "3f1c9a52-…"
  }
}
```

- `details` is present on some errors (see each endpoint).
- `message` is for logs and support, not for showing to users as-is.
- Always branch on the HTTP status and `code`, never on `message`.

## 3. Endpoints

### 3.1 List the pills

`GET /categories?kind=audio&root=sound-effects`

| Query | Required | Notes |
|---|---|---|
| `kind` | yes | `audio` |
| `root` | yes | `sound-effects` |

`200`:

```json
{
  "success": true,
  "data": [
    { "id": "cm1alerts", "slug": "alerts", "name": "Alerts", "children": [] },
    {
      "id": "cm1ui",
      "slug": "ui",
      "name": "UI",
      "children": [
        { "id": "cm1uiclicks", "slug": "ui-clicks", "name": "UI clicks", "children": [] }
      ]
    }
  ]
}
```

- Only visible categories are returned. A hidden category and everything under it are left out.
- Use `slug` as the `category` value when listing sounds. `id` is stable too, but nothing takes it.
- `data` can be an empty array (the root exists but has no visible children yet). Show an
  empty state.

| Status | `code` | When |
|---|---|---|
| 404 | `NOT_FOUND` | No visible top-level `audio` category with that slug (for example, not created yet in the dashboard) |
| 422 | `VALIDATION_FAILED` | `kind` or `root` missing or invalid |
| 429 | `RATE_LIMITED` | See §5 |

### 3.2 List sounds

`GET /assets?kind=audio&category=<slug>&cursor=<cursor>&limit=<n>`

| Query | Required | Notes |
|---|---|---|
| `kind` | yes | `audio` |
| `category` | no | A slug from §3.1, or `sound-effects` for all sound effects. Includes sub-categories. |
| `cursor` | no | `meta.nextCursor` from the previous page. Omit for the first page. |
| `limit` | no | 1–50, default 30 |

`200`:

```json
{
  "success": true,
  "data": [
    {
      "id": "cm2a1",
      "slug": "ui-button-3f9a2c1d",
      "title": "UI Button",
      "author": "SlimShot",
      "durationMs": 412,
      "category": { "slug": "ui", "name": "UI" },
      "cover": { "url": "https://cdn.techfamz.com/slimshot/covers/5c0e….png" }
    },
    {
      "id": "cm2a2",
      "slug": "chime-ding-91b2e0aa",
      "title": "Chime Ding",
      "author": "SlimShot",
      "durationMs": 1830,
      "category": { "slug": "alerts", "name": "Alerts" },
      "cover": null
    }
  ],
  "meta": { "nextCursor": "cm2a2" }
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | string | Pass to download (§3.3) |
| `slug` | string | Readable and unique, but not a display name |
| `title` | string | Show this |
| `author` | string | Credit line |
| `durationMs` | integer | Length in milliseconds. Format it yourself, e.g. `0:01`. |
| `category` | object or null | The sound's own category (possibly a sub-category of the pill you asked for). `null` only when listing without `category`. |
| `cover` | object or null | `null` when the sound has no cover. Show your fallback tile. Covers are JPEG, PNG or WebP, usually square. |

- Only published sounds are listed. Order is **newest first**.
- The original file's address is never in a list; ask for it with §3.3.

| Status | `code` | When |
|---|---|---|
| 404 | `NOT_FOUND` | `category` is unknown or hidden. Reload the pills: the dashboard changed them. |
| 422 | `VALIDATION_FAILED` | `kind` missing, `limit` outside 1–50, or a `cursor` that isn't from this listing |
| 429 | `RATE_LIMITED` | See §5 |

### 3.3 Download a sound

`POST /assets/:id/download` (no body)

`200`:

```json
{
  "success": true,
  "data": {
    "url": "https://cdn.techfamz.com/slimshot/audio/0b6f….mp3",
    "expiresAt": "2026-10-18T12:10:00.000Z",
    "filename": "ui-button-3f9a2c1d.mp3",
    "format": "mp3",
    "byteSize": 81234,
    "durationMs": 412
  }
}
```

**Flow:** when the user taps the download icon:
1. Call this endpoint.
2. Fetch `url` straight away with a plain GET (no headers needed).
3. Save the bytes in the app's library.
4. Swap the icon for "+".

Use `filename` (or `format` for the extension) when saving. `byteSize` lets you show
progress. Each call counts as one download.

- **Don't store or reuse `url`.** Treat it as valid only until `expiresAt` (10 minutes). To
  download again, call this endpoint again.
- `format` is one of `mp3`, `wav`, `aac`, `ogg`, `flac`. The file's real format is checked by
  the server, so `format` matches the bytes.

| Status | `code` | When |
|---|---|---|
| 404 | `NOT_FOUND` | Unknown id, or the sound was unpublished or removed. Drop it from the list. |
| 403 | `FORBIDDEN` | Not used today. Reserved for when some downloads need sign-in or credits. Show "not available". |
| 429 | `RATE_LIMITED` | See §5 |

## 4. Paging

- Paging is **cursor-based**. First page: no `cursor`. Next page: send `cursor` = the previous
  response's `meta.nextCursor`. Stop when `meta.nextCursor` is `null`.
- A cursor is opaque: never build or change one. Use it only with the same `kind` and
  `category` it came from.
- Sounds published while the user scrolls never appear twice or shift pages. They appear at the
  top on the next refresh.
- A page can hold fewer than `limit` items. Only `nextCursor: null` means the end.

## 5. Rate limits

Per client IP address:

| What | Limit |
|---|---|
| Browsing (§3.1 and §3.2 together) | 120 requests per minute |
| Downloads (§3.3) | 30 per minute |

Over the limit, the answer is `429`:

```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests. Try again later.",
    "details": { "retryAfterSeconds": 41 },
    "traceId": "…"
  }
}
```

Wait `details.retryAfterSeconds` before retrying. Don't retry in a loop.

## 6. Caching and freshness

- The server caches category and list answers for up to 5 minutes, but any change in the
  dashboard clears that cache at once. So a pull-to-refresh after the owner publishes, edits,
  re-files or re-covers a sound shows the change.
- The app may cache pills and pages for the session, and should refetch on pull-to-refresh and
  when the sheet is reopened.
- Cover images are served from a CDN and can be cached by the image loader. A changed cover
  gets a new URL.

## 7. What not to rely on

- **URL shapes and hosts.** Use `cover.url` and `url` exactly as given. Don't build file URLs
  from ids or slugs.
- **A download `url` after `expiresAt`.** It may keep working today, but that will change
  without notice.
- **Order** beyond "newest first", and **pill order** beyond "as returned".
- **Fields not documented here**, and **field order** in JSON.
- **`slug` as a title**, or the exact text of any `message`.

## 8. Changelog

- 2026-10-18: first version (categories, sounds with covers, downloads; no previews).
