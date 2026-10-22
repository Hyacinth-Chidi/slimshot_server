# Fonts in the library: design

Date: 2026-10-22. Repos: `slimshot_server` (server), `slimshot-admin` (dashboard). Source: the
app developer's brief ("SlimShot Font Library", an artifact the owner relayed) and the owner's
answers in conversation. Sounds are not changed in any way by this work.

## 1. Why

The editor's text tool gets a **Font** tab. Users pick from a curated set of fonts, see each
one drawn as a preview before downloading anything, tap to download and apply it, and keep it on
the phone for good. Projects and templates must always be able to fetch the exact font they were
made with, by id, or by family name for projects made before ids existed. The owner curates the
set from the dashboard, with no app release.

## 2. What users see (the app's side, for context)

- Font tab: search, then **Downloaded** (app-only: the phone's System font plus three fonts
  bundled in the app, never listed by the server), then one grid: **the fonts in Trending, in
  the order the owner sets**. The app reads the whole list once, caches it, and searches it on
  the phone.
- Each tile is a **preview image**: the font's name drawn in that font. A download arrow marks a
  font not yet on the phone. First tap downloads (no confirmation), counts as a download, and
  applies the font.
- Downloaded fonts stay on the phone. Projects store the font **id**; older projects store the
  **family name** ("Playfair Display"). A project whose font is missing downloads it by id (or
  family name) automatically.

## 3. Goals

1. Fonts as a catalogue kind (`font`), managed in the dashboard's **Library › Fonts**.
2. **One category, Trending** (owner's decision). The app shows exactly the fonts in Trending,
   top to bottom in the owner's order. No font is ever in more than one category.
3. Per font: display name, family name, style, the file, a server-made preview image, a licence
   note, a download count, a version.
4. A font taken out of Trending is still downloadable by id and by family name. **Fonts are
   never deleted.**
5. A font's file never changes silently: a fix is a **new version** of the same font (same id,
   same family), and the app re-downloads when its stored version is lower (owner agreed).

## 4. Non-goals and anti-goals

- **Not now:** a premium flag; more font categories or style shelves; server-side search;
  WOFF/WOFF2; variable fonts; multi-face files (TTC/OTC); deleting published fonts; non-Latin
  scripts (right-to-left, Indic); colour and emoji fonts.
- **Anti-goals (failure even if it "works"):**
  - Anything that changes how sounds behave, list or download.
  - A project losing its font: a font that disappears, a download that 404s for a font a project
    uses, or a file replaced under the same version.
  - A preview that doesn't match the file the app downloads.
  - Accepting a file the app's text engine can't load (WOFF, variable, collection, corrupt).

## 5. Data (additive migration only)

- `AssetKind.font` already exists. Add a `FontAsset` detail table, like `AudioAsset`:
  - `assetId` (PK, FK to Asset)
  - `familyName` — read from the file (typographic family, name ID 16, else name ID 1)
  - `styleName` — read from the file (typographic subfamily, name ID 17, else name ID 2), e.g.
    `Regular`, `Bold`, `SemiBold Italic`
  - `fullName` (name ID 4) and `postscriptName` (name ID 6), for the download filename
  - `version` Int, starts at 1
  - `sortOrder` Int — position in Trending
  - `firstPublishedAt` DateTime? — set on first publish, never cleared (see §9)
  - `license` String? — free text, for the owner's records, never sent to the app
  - **Unique on (`familyName`, `styleName`)**, compared case-insensitively. See §10, call 1.
- Display name is the existing `Asset.title`. Download count is the existing `Asset.downloadCount`.
- Files (existing `AssetFile`):
  - `original`: the font file. Every version is kept; the current one is the `isPrimary` row, and
    each row records its version in `variant` (`{ "version": n }`).
  - `specimen`: the preview PNG (one current row; replaced when the preview is redrawn).
- Category: the owner creates a top-level **font** category named **Trending** (slug `trending`)
  in the dashboard. The app asks for that slug, the same way it asks for `sound-effects`.

## 6. Upload and checks (server)

- Upload goes through the existing ticket → R2 PUT → finalize flow with `kind: "font"`.
  Declared types: `font/ttf` for `.ttf`, `font/otf` for `.otf` (declared from the extension,
  as audio does). Size cap `UPLOAD_FONT_MAX_BYTES`, default 10 MB.
- Finalize reads the file back and checks its bytes, not its name:
  - sfnt signature `00 01 00 00` or `true` → TTF; `OTTO` → OTF. Anything else (WOFF `wOFF`,
    WOFF2 `wOF2`, collection `ttcf`, not a font) is refused and the object deleted, as audio does.
  - Must parse; must not be a variable font (has an `fvar` table / variation axes) — refused.
  - Reads family, style, full name and PostScript name. A missing family name is refused.
  - **Latin-script fonts only** (the app draws left to right, Latin only): a font without glyphs
    for the basic Latin letters A–Z and a–z is refused.
  - **Colour and emoji fonts are refused** (any of the `COLR`, `CBDT`, `sbix` or `SVG ` tables):
    emoji in the app always come from the phone's own emoji font.
  - A font whose (family, style) already exists is refused with a clear message naming the
    existing font, and the object deleted.
- On success: FontAsset row (version 1), original file row, **preview drawn and stored**, asset
  `ready`. Audit row.

## 7. The preview image

- PNG, **480 × 160**, transparent background, **white** text, the text scaled down to fit the
  width with side padding and vertically centred.
- Text: the font's display name (`Asset.title`).
- Drawn from the uploaded file itself, so it always matches what the app downloads.
- Redrawn when the display name changes, and when a new version is uploaded.
- Stored in the public bucket under `slimshot/fonts/previews/`; the app gets its URL.
- If drawing fails, finalize still succeeds and the font is flagged "no preview" in the
  dashboard; it cannot be published until it has one (editing the display name retries).
- **My call:** drawn with `fontkit` (reads the font and lays out the text) and `@resvg/resvg-js`
  (turns the drawing into a PNG). Both install without build steps and work in the server's
  Docker image.

## 8. New version of a font

- Dashboard: **Upload new version** on the font's page. Server: the same ticket flow with
  `role: "original"` and the `assetId` of the existing font (as covers use `role: "thumbnail"`).
- Finalize checks the file as in §6, **plus**: its family and style must equal the font's
  (otherwise refused: "This file is <family style>, not <family style>").
- On success: the new file becomes the primary original, the previous rows stay (never deleted),
  `version` + 1, preview redrawn, catalogue cache cleared, audit row.

## 9. Lifecycle rules

- A font that has **never** been published behaves like a sound: it can be published, and it can
  be deleted (a mistaken upload). Its (family, style) is then free to upload again: the
  uniqueness check ignores deleted fonts.
- Once published, a font **cannot be unpublished or deleted** (server refuses; dashboard hides
  those actions). Taking it out of the app means taking it out of Trending. "Has ever been
  published" is recorded in a new `FontAsset.firstPublishedAt` column, because
  `Asset.publishedAt` is cleared on unpublish.
- A font needs a preview to be published.
- A newly uploaded font goes to the **end** of the Trending order. Its display name starts as the
  file's full name (name ID 4), e.g. "Playfair Display Bold", and can be edited.

## 10. App API (`api/app/v1/catalog`, no sign-in, same envelope, limits and cache as sounds)

- `GET /catalog/fonts?category=trending` → every published font in that category, in the
  owner's order, one list (no paging). 404 if the category doesn't exist or is hidden.
- `GET /catalog/fonts/:id` → one published font, in Trending or not. 404 otherwise.
- `GET /catalog/fonts/by-family/:familyName` → for **old projects only** (new ones store the id):
  the published font whose family name equals `familyName` and whose style is `Regular`. Exact
  match. 404 if none.
  - Old projects store one string, the family name, with no weight or italic, and always drew
    Google fonts in Regular, so returning Regular loses nothing (app developer).
  - The list of names that can arrive here is fixed and will never grow: the 19 Google families
    **Montserrat, Lato, Oswald, Bebas Neue, Playfair Display, Pacifico, Dancing Script, Poppins,
    Raleway, Inter, Nunito, Lobster, Caveat, Abril Fatface, Righteous, Permanent Marker,
    Press Start 2P, Cinzel, Sacramento**, spelled as Google spells them, which is also the family
    name inside Google's Regular files. The app resolves its own bundled fonts and "Roboto"
    itself.
  - For old projects to find their fonts, the owner uploads and publishes the **Regular** file of
    each of these 19 families. They don't have to be in Trending. The dashboard shows which of
    the 19 are still missing (a small checklist on the Fonts page).
- Font item:
  ```json
  {
    "id": "…", "displayName": "Playfair", "familyName": "Playfair Display",
    "styleName": "Bold", "version": 2, "format": "ttf",
    "preview": { "url": "https://cdn.techfamz.com/slimshot/fonts/previews/….png", "width": 480, "height": 160 }
  }
  ```
- Download: the existing `POST /catalog/assets/:id/download`, unchanged for sounds. For a font it
  returns the current version's file (the `isPrimary` original), `filename` =
  `<PostScriptName>.<ttf|otf>` (the asset slug if the file has no PostScript name), and adds
  `version`. It works for any published font, in Trending or not. **Every** download request
  counts, including the app's automatic re-downloads; the app can add a reason later if the
  owner wants taps counted apart.
- The list covers fonts filed **directly** in the category (Trending has no sub-categories).
  `GET /catalog/assets` stays the sounds endpoint and refuses `kind=font` with a 422 pointing to
  `/catalog/fonts`.
- Caching: the list is cached and cleared on any font or Trending change, as sounds are.
- **My calls:** search stays on the phone (the developer offered both; the list is small).
  Fonts get their own endpoints rather than reusing `/catalog/assets`, because a font item has
  different fields and order.

## 11. Dashboard: Library › Fonts

- `/fonts` (Fonts | Categories tabs), `/fonts/categories`, `/fonts/[id]`, appearing in the
  sidebar once the server lists the font kind (already wired).
- **List:** each row shows the preview image on a dark tile, display name, family + style,
  version, status, downloads. When filtered to Trending, rows can be **dragged to reorder**; the
  order saves at once.
- **Upload:** the existing drawer, kind fixed to fonts, accepting `.ttf`/`.otf`, with the batch
  category picker (Trending).
- **Font page:** preview, display name (editable), family and style (read-only, from the file),
  version, licence note (editable), category, Publish (until first published), Upload new version, downloads.
- **Categories tab:** the same tree as Audio; its empty state says to create "Trending" (the
  dashboard's font section currently names "Fonts"; that changes to "Trending").
- Admin API additions: font fields on the admin asset view; `PATCH` for `license`; `POST`
  reorder for Trending; the ticket's `assetId` for new versions; the list of the 19 legacy
  families with whether each has a published Regular font.

## 12. Contract doc

`docs/app-catalog-api.md` gains a Fonts section the Flutter app can build against alone:
endpoints, item fields, the Trending convention, ordering, how to use `version`, the family-name
lookup rule, download filename, caching, and what not to rely on.

## 13. Calls I made (for the owner to check)

1. **Uniqueness is per face, not per family.** The brief says the family name is unique, and also
   that Poppins Regular and Poppins Bold are two separate fonts. Both can't hold, so the unique
   key is family + style. Looking a font up by family name returns that family's Regular face,
   which the app developer confirmed is what old projects always drew.
2. Published fonts can't be unpublished or deleted; leaving Trending is how a font leaves the app.
3. Licence is free text.
4. The preview shows the display name, redrawn when it changes.
5. Search happens on the phone; no search endpoint.
6. Fonts have their own app endpoints; the download endpoint is shared with sounds.
7. Preview drawing uses fontkit + resvg-js (exact for Latin, left-to-right text, which is all the
   app draws).
12. The Fonts page lists which of the 19 legacy Google families still lack a published Regular
    font.
8. Font size cap 10 MB (`UPLOAD_FONT_MAX_BYTES`).
9. Never-published fonts can be deleted; published ones never. A new `firstPublishedAt` column
   records the difference.
10. Every download request counts, automatic re-downloads included.
11. New fonts land at the end of Trending; the display name starts as the file's full name.

## 14. Left to the builder

Exact padding and maximum text size in the preview; the dashboard's drag-to-reorder
interaction details; migration naming; error message wording beyond the ones quoted here; how
the "no preview" state looks.
