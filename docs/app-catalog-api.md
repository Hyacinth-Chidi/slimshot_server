# Catalogue API (for the app): sounds and fonts

The contract for the editor's **Sound effects** sheet (category pills, then rows of
**cover · title · duration · download**) and its **Font** tab (§8). Build against this document
alone. Anything it does not promise, don't rely on.

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
| `author` | string | Optional metadata; may be an empty string. The app doesn't need to show it. |
| `durationMs` | integer | Length in milliseconds. Format it yourself, e.g. `0:01`. |
| `category` | object or null | The sound's own category (possibly a sub-category of the pill you asked for). `null` only when listing without `category`. |
| `cover` | object or null | Optional. `null` when the sound has no cover: show the default cover image bundled in the app. The server never sends a default. Covers are JPEG, PNG or WebP, usually square. |

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

## 8. Fonts

The Font tab shows one grid: **every published font, in the order the owner sets in the
dashboard**. There are no font categories. The app reads the whole list once, caches it, and
searches it on the phone. "Downloaded", the System font and the fonts bundled in the app are the app's own and
never come from the server.

### 8.1 List the fonts

`GET /fonts`

`200` (one list, no paging):

```json
{
  "success": true,
  "data": [
    {
      "id": "cm9f1",
      "displayName": "Playfair Display",
      "familyName": "Playfair Display",
      "styleName": "Regular",
      "version": 2,
      "format": "ttf",
      "preview": { "url": "https://cdn.techfamz.com/slimshot/fonts/previews/7c1e….png", "width": 480, "height": 160 }
    }
  ]
}
```

| Field | Notes |
|---|---|
| `id` | Store this in projects: it never changes for this font. |
| `displayName` | The tile's label, and what search matches. The owner can rename it. |
| `familyName`, `styleName` | Read from the font file, never edited. One file is one face: Lato Regular and Lato Bold are two fonts. |
| `version` | Starts at 1 and goes up each time the owner uploads a fixed file for this font. Keep it with the downloaded file and download again when the server's is higher. |
| `format` | `ttf` or `otf`. Never WOFF, never variable or colour fonts; all are Latin-script, drawn left to right. |
| `preview` | The font's name drawn in the font itself: white on transparent, 480 × 160 PNG. Show it on a dark tile. Listed fonts always have one; it is `null` only if the server could not draw it, which listed fonts never are. |

Every published font is listed, in the owner's order (fonts at the same position: newest
first). A font that becomes published goes to the **top** of that order, so new fonts show first
until the owner moves them. An empty list is `200` with `data: []`.

`?category=<slug>` still works (only the fonts filed in that font category, 404 `NOT_FOUND` if
there is none), but nothing needs it: fonts no longer use categories.

| Status | `code` | When |
|---|---|---|
| 429 | `RATE_LIMITED` | Counts with the other reads (§5) |

### 8.2 One font by id

`GET /fonts/:id` → `{ "success": true, "data": <font item> }`

For a project that uses a font the phone doesn't have: works for any published font. 404 `NOT_FOUND` if the font is unknown, not published (never, or no longer), or deleted.

### 8.3 One font by family name (projects made before font ids)

`GET /fonts/by-family/:familyName` (URL-encode the name: `/fonts/by-family/Playfair%20Display`)

Old projects store one string, the family name, and always drew its Regular style. This returns
the published **Regular** font of that family: exact spelling, case included. 404 `NOT_FOUND` if
there is none. The names that can arrive here are exactly these 19 Google families: Montserrat,
Lato, Oswald, Bebas Neue, Playfair Display, Pacifico, Dancing Script, Poppins, Raleway, Inter,
Nunito, Lobster, Caveat, Abril Fatface, Righteous, Permanent Marker, Press Start 2P, Cinzel,
Sacramento. Resolve the app's bundled fonts and "Roboto" yourself. Once found, store the font's
`id` in the project and use §8.2 from then on.

### 8.4 Download a font

The same `POST /assets/:id/download` as sounds (§3.3), with the font's `id`. Every call counts as
a download, including automatic re-downloads.

```json
{
  "success": true,
  "data": {
    "url": "https://cdn.techfamz.com/slimshot/fonts/3b0e….ttf",
    "expiresAt": "2026-10-22T12:10:00.000Z",
    "filename": "PlayfairDisplay-Regular.ttf",
    "format": "ttf",
    "byteSize": 301268,
    "version": 2
  }
}
```

- `url` is always the **current version's** file. Fetch it straight away; don't store it (§3.3).
- Save the file with `version`, and register it with the text engine under the font's `id`.
- A font's file never changes under the same `version`. A fixed file arrives as a higher
  `version` of the same `id`; earlier files stay valid for anything already made with them.
- The owner can unpublish or delete a font, like a sound. From then on its id answers 404 here
  and in §8.2–8.3, and it leaves the list. A copy already on the phone is the app's own: keep
  using it. A project whose font is gone and not on the phone falls back to a font the app
  bundles.

### 8.5 Caching

As for sounds (§6): the list and lookups are cached on the server for up to 5 minutes, and any
change in the dashboard (publishing, unpublishing, deleting, reordering, renaming, a new version)
clears it at once.

## 9. Changelog

- 2026-10-22: fonts have no categories. `GET /fonts` lists every published font in the owner's
  order; a newly published font goes to the top (§8.1). `?category=` still works but is not
  needed.
- 2026-10-22: a published font can now be unpublished or deleted, like a sound (§8.4). Its id
  then answers 404; keep any copy already downloaded.
- 2026-10-22: fonts (§8): the Trending list, lookups by id and by family name, downloads with
  `version`.
- 2026-10-18: first version (categories, sounds with covers, downloads; no previews).
