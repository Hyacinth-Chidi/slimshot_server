# SlimShot Content Platform — Design

**Date:** 2026-09-11
**Status:** Approved for planning
**Repo:** `slimshot_server` (NestJS 11 · Prisma 7 · Neon Postgres · Redis · Cloudinary)

## 1. Purpose

`slimshot_server` is the content and configuration backend for the SlimShotAI mobile
app. It serves a curated catalog of creative assets — audio today, fonts and templates
next — to the app, and gives an internal team an authenticated API to manage that
catalog, the system's own configuration, and app release metadata.

The design target is a general asset platform, not an audio API with extras bolted on.
Adding a new asset kind must cost one module and one migration, with no edits to ingest,
delivery, search, or admin CRUD.

## 2. Goals

- One catalog model serving heterogeneous asset kinds.
- Admin-managed taxonomy: nested categories per kind, curated collections, normalized tags.
- All operational configuration — including third-party provider credentials — stored in
  the database and editable by an authorized admin at runtime.
- Storage provider is an interface, not an assumption. Cloudinary is one implementation.
- Asset downloads pass through an entitlement checkpoint from day one, so paid tiers later
  are a configuration change rather than a migration.
- Identity schema designed now, dormant until the app onboards users.
- The Vercel update API folds in as a first-class release channel.

## 3. Non-goals

- No admin dashboard frontend. The deliverable is a documented API (generated OpenAPI).
  One hardened internal ops page may remain for operator use.
- No user-facing authentication endpoints. Schema only.
- No billing or payment integration.
- No creator/community publishing UI. The model reserves space for it; no endpoints.
- No changes to the Flutter app in this project.

## 4. Constraints and decisions

These were settled before design; everything downstream assumes them.

| Decision | Choice | Consequence |
|---|---|---|
| Who publishes | Admin-curated now, creators later | `ownerId`, `visibility`, `moderationState` exist from day one, dormant |
| Access gating | Free now, gated later | Downloads always route through an entitlement checkpoint returning a signed URL |
| Infrastructure | Container + managed Redis | BullMQ workers, distributed cache, Redis rate limiting all available |
| Admin surface | API only | OpenAPI generated; dashboard is a separate future project |
| Asset modelling | Base table + typed detail tables | Real columns, real FKs, unified query surface; new kind costs a migration |
| File storage | Pointers in DB, bytes in object storage | `AssetFile` holds provider + key + metadata. No blobs, no base64, ever |

### 4.1 The one unavoidable exception to "nothing hardcoded"

Three values must come from the environment and cannot live in the database:

- `DATABASE_URL` — the database cannot be queried to learn how to reach the database.
- `MASTER_ENCRYPTION_KEY` — the key that decrypts stored secrets. Storing it beside its
  own ciphertext is not encryption.
- `PORT` / `NODE_ENV`.

Everything else is database-resident and admin-editable: Cloudinary and S3 credentials,
JWT signing secrets, upload caps, allowed MIME types, rate limits, cache TTLs, CDN
hostnames, feature flags, and the default storage provider.

## 5. Data model

The schema blocks below are the intended shape, not verbatim final Prisma. Two
conventions apply throughout:

- **Actor columns** (`createdById`, `updatedById`) are real relations to `AdminUser` with
  `onDelete: SetNull`. `AdminUser` is soft-deleted, so these effectively never null out;
  the relation exists so "assets created by X" is a join rather than a manual lookup.
- **Cover images** on `Category` and `Collection` are not `AssetFile` rows — an
  `AssetFile` always belongs to a catalog asset, and a category cover is not one. Covers
  use the same pointer triple inline: `coverStorageId`, `coverStorageKey`, `coverUrl`,
  all nullable. They are uploaded through dedicated endpoints
  (`POST /admin/v1/categories/:id/cover`, same for collections) that issue a storage
  ticket and write the three columns on finalize — not through the asset ingest pipeline,
  since `FileRole` describes roles within an asset. The storage cleanup job scans these
  columns alongside `AssetFile`.

### 5.1 Enums

```prisma
enum AssetKind       { audio font template }
enum AssetStatus     { draft processing ready published archived failed }
enum Visibility      { public unlisted private }
enum ModerationState { pending approved rejected }
enum FileRole        { original preview thumbnail poster waveform specimen font_file project }
enum StorageKind     { cloudinary s3 r2 bunny }
enum AdminRole       { owner admin editor viewer }
enum Platform        { android ios web }
enum ReleaseChannel  { production beta internal }
enum AccountStatus   { active suspended deleted }
enum UploadState     { pending uploaded finalized expired aborted }
```

### 5.2 Catalog spine

```prisma
model Asset {
  id              String          @id @default(cuid())
  kind            AssetKind
  slug            String
  title           String
  description     String?
  authorName      String                             // display credit, not ownership
  ownerId         String?                            // dormant: creator publishing
  visibility      Visibility      @default(public)
  status          AssetStatus     @default(draft)
  moderationState ModerationState @default(approved)  // dormant
  categoryId      String?
  licenseId       String?
  createdById     String?                            // AdminUser
  updatedById     String?
  attributes      Json?                              // escape hatch, not a dumping ground
  downloadCount   Int             @default(0)
  favoriteCount   Int             @default(0)
  publishedAt     DateTime?
  createdAt       DateTime        @default(now())
  updatedAt       DateTime        @updatedAt
  deletedAt       DateTime?                          // soft delete
  searchVector    Unsupported("tsvector")?

  owner       User?                @relation(fields: [ownerId], references: [id])
  category    Category?            @relation(fields: [categoryId], references: [id])
  license     License?             @relation(fields: [licenseId], references: [id])
  files       AssetFile[]
  tags        AssetTag[]
  collections CollectionItem[]
  audio       AudioAsset?
  font        FontAsset?
  template    TemplateAsset?
  requiredBy  TemplateDependency[] @relation("DependencyAsset")

  @@unique([kind, slug])
  @@index([kind, status, publishedAt(sort: Desc)])
  @@index([categoryId, status])
  @@index([status, deletedAt])
}
```

Status lifecycle: `draft → processing → ready → published → archived`, with `failed`
reachable from `processing`. The `ready`/`published` split is deliberate — a batch upload
can finish processing and be reviewed before anything becomes visible to the app.

```prisma
model AssetFile {
  id             String   @id @default(cuid())
  assetId        String
  role           FileRole
  storageId      String                    // which provider physically holds it
  storageKey     String                    // Cloudinary publicId or S3 object key
  deliveryUrl    String?                   // cached public URL (public roles only)
  mimeType       String
  format         String
  byteSize       Int
  checksumSha256 String?
  width          Int?
  height         Int?
  durationMs     Int?
  variant        Json?                     // e.g. { "weight": 700, "style": "italic" }
  isPrimary      Boolean  @default(false)
  createdAt      DateTime @default(now())

  asset   Asset           @relation(fields: [assetId], references: [id], onDelete: Cascade)
  storage StorageProvider @relation(fields: [storageId], references: [id])

  @@unique([storageId, storageKey])
  @@index([assetId, role])
  @@index([checksumSha256])
}
```

Every file records the provider that holds it. This is what makes changing the default
provider safe: new uploads go somewhere new while existing files keep resolving from
where they actually are.

### 5.3 Typed detail tables

```prisma
model AudioAsset {
  assetId     String  @id
  durationMs  Int                     // milliseconds; SFX are too short for integer seconds
  bpm         Int?
  musicalKey  String?
  isLoopable  Boolean @default(false)
  sampleRate  Int?
  bitrateKbps Int?
  channels    Int?
  asset       Asset   @relation(fields: [assetId], references: [id], onDelete: Cascade)
}

model FontAsset {
  assetId        String   @id
  family         String                 // models the family; weights are AssetFile rows
  foundry        String?
  isVariable     Boolean  @default(false)
  supportsItalic Boolean  @default(false)
  scripts        String[]               // latin, cyrillic, arabic, …
  glyphCount     Int?
  asset          Asset    @relation(fields: [assetId], references: [id], onDelete: Cascade)
}

model TemplateAsset {
  assetId             String @id
  durationMs          Int
  aspectRatio         String            // "9:16"
  width               Int
  height              Int
  clipSlotCount       Int               // media the user must supply
  engineSchemaVersion Int               // a template is a program the editor executes
  minAppVersion       String
  asset               Asset  @relation(fields: [assetId], references: [id], onDelete: Cascade)
  dependencies        TemplateDependency[]
}

model TemplateDependency {
  templateAssetId String
  dependencyId    String
  required        Boolean @default(true)

  template   TemplateAsset @relation(fields: [templateAssetId], references: [assetId], onDelete: Cascade)
  dependency Asset         @relation("DependencyAsset", fields: [dependencyId], references: [id])

  @@id([templateAssetId, dependencyId])
  @@index([dependencyId])
}
```

`engineSchemaVersion` and `minAppVersion` are load-bearing. A template authored against
editor engine v3 must never be served to an app running v2; without these, publishing a
template silently breaks older installs. Delivery filters on both.

`TemplateDependency` makes "what breaks if I delete this font?" answerable before the
delete rather than after.

### 5.4 Taxonomy

```prisma
model Category {
  id          String    @id @default(cuid())
  kind        AssetKind                  // an SFX category can never be offered for fonts
  parentId    String?                    // self-referencing tree
  slug        String
  name        String
  description String?
  coverStorageId  String?
  coverStorageKey String?
  coverUrl        String?
  sortOrder   Int       @default(0)
  isActive    Boolean   @default(true)
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  parent   Category?  @relation("CategoryTree", fields: [parentId], references: [id])
  children Category[] @relation("CategoryTree")
  assets   Asset[]

  @@unique([kind, slug])
  @@index([kind, parentId, sortOrder])
}

model Collection {
  id          String           @id @default(cuid())
  slug        String           @unique
  name        String
  description String?
  coverStorageId  String?
  coverStorageKey String?
  coverUrl        String?
  isActive    Boolean          @default(true)
  sortOrder   Int              @default(0)
  items       CollectionItem[]
}

model CollectionItem {
  collectionId String
  assetId      String
  sortOrder    Int        @default(0)
  collection   Collection @relation(fields: [collectionId], references: [id], onDelete: Cascade)
  asset        Asset      @relation(fields: [assetId], references: [id], onDelete: Cascade)

  @@id([collectionId, assetId])
  @@index([collectionId, sortOrder])
}

model Tag {
  id         String     @id @default(cuid())
  slug       String     @unique
  name       String
  kind       AssetKind?             // null = applies to any kind
  usageCount Int        @default(0)
  assets     AssetTag[]
}

model AssetTag {
  assetId String
  tagId   String
  asset   Asset @relation(fields: [assetId], references: [id], onDelete: Cascade)
  tag     Tag   @relation(fields: [tagId], references: [id], onDelete: Cascade)

  @@id([assetId, tagId])
  @@index([tagId])
}

model License {
  id                  String  @id @default(cuid())
  name                String  @unique
  summary             String?
  url                 String?
  requiresAttribution Boolean @default(false)
  allowsCommercial    Boolean @default(true)
  attributionText     String?
  assets              Asset[]
}
```

Tags are a join table, not the current `String[]`. Rename becomes one row update instead
of rewriting every asset; merge is a deduplicating join rewrite; "unused tags" is a
`GROUP BY` rather than an unanswerable question.

Categories are the filing system (one per asset); collections are the merchandising
surface (many, ordered, cross-kind). Conflating them is the common mistake.

### 5.5 Platform tables

```prisma
model StorageProvider {
  id           String      @id @default(cuid())
  kind         StorageKind
  name         String      @unique
  isDefault    Boolean     @default(false)
  isActive     Boolean     @default(true)
  configCipher Bytes                        // AES-256-GCM envelope, see §6.4
  keyVersion   Int         @default(1)
  publicConfig Json?                        // non-secret: bucket, region, cdn host, folder
  lastTestedAt DateTime?
  createdAt    DateTime    @default(now())
  updatedAt    DateTime    @updatedAt
  files        AssetFile[]
}

model SystemSetting {
  key          String   @id            // "upload.audio.maxBytes"
  group        String                  // "upload" — for admin grouping
  valueJson    Json?                   // set when isSecret = false
  valueCipher  Bytes?                  // set when isSecret = true
  keyVersion   Int?
  isSecret     Boolean  @default(false)
  updatedById  String?
  updatedAt    DateTime @updatedAt

  @@index([group])
}

model AdminUser {
  id           String         @id @default(cuid())
  email        String         @unique
  passwordHash String
  name         String
  role         AdminRole      @default(editor)
  isActive     Boolean        @default(true)
  lastLoginAt  DateTime?
  createdAt    DateTime       @default(now())
  updatedAt    DateTime       @updatedAt
  deletedAt    DateTime?
  tokens       RefreshToken[]
}

model RefreshToken {
  id          String    @id @default(cuid())
  tokenHash   String    @unique
  familyId    String                       // rotation lineage; reuse revokes the family
  adminUserId String
  expiresAt   DateTime
  revokedAt   DateTime?
  userAgent   String?
  ip          String?
  createdAt   DateTime  @default(now())
  admin       AdminUser @relation(fields: [adminUserId], references: [id], onDelete: Cascade)

  @@index([adminUserId, revokedAt])
  @@index([familyId])
}

model AuditLog {
  id         String   @id @default(cuid())
  actorId    String?
  actorType  String                        // "admin" | "system"
  action     String                        // "asset.publish"
  entityType String
  entityId   String?
  before     Json?
  after      Json?
  ip         String?
  userAgent  String?
  createdAt  DateTime @default(now())

  @@index([entityType, entityId])
  @@index([actorId, createdAt(sort: Desc)])
  @@index([createdAt(sort: Desc)])
}

model UploadSession {
  id           String      @id @default(cuid())
  assetId      String
  role         FileRole
  storageId    String
  storageKey   String
  state        UploadState @default(pending)
  expiresAt    DateTime
  declaredMime String
  declaredSize Int
  createdById  String
  createdAt    DateTime    @default(now())
  finalizedAt  DateTime?

  @@index([state, expiresAt])
  @@index([assetId])
}

model AppRelease {
  id                  String         @id @default(cuid())
  platform            Platform
  channel             ReleaseChannel @default(production)
  version             String
  buildNumber         Int
  minSupportedVersion String
  forceUpdate         Boolean        @default(false)
  title               String
  releaseNotes        String[]
  updateUrl           String
  isActive            Boolean        @default(false)
  publishedAt         DateTime?
  createdAt           DateTime       @default(now())
  updatedAt           DateTime       @updatedAt

  @@unique([platform, channel, buildNumber])
  @@index([platform, channel, isActive])
}
```

### 5.6 Identity — designed now, dormant

```prisma
model User {
  id            String        @id @default(cuid())
  email         String?       @unique
  phone         String?       @unique
  displayName   String?
  avatarUrl     String?
  accountStatus AccountStatus @default(active)
  tier          String        @default("free")
  createdAt     DateTime      @default(now())
  updatedAt     DateTime      @updatedAt
  deletedAt     DateTime?

  devices      Device[]
  entitlements UserEntitlement[]
  downloads    AssetDownload[]
  favorites    AssetFavorite[]
  assets       Asset[]
}

model Device {
  id         String   @id @default(cuid())
  installId  String   @unique             // generated client-side, survives logout
  userId     String?                      // null until accounts exist
  platform   Platform
  appVersion String
  osVersion  String?
  locale     String?
  pushToken  String?
  lastSeenAt DateTime @default(now())
  createdAt  DateTime @default(now())

  user      User?           @relation(fields: [userId], references: [id])
  downloads AssetDownload[]
  favorites AssetFavorite[]

  @@index([userId])
  @@index([lastSeenAt])
}

model UserEntitlement {
  id        String    @id @default(cuid())
  userId    String
  sku       String
  source    String                        // "purchase" | "promo" | "grant"
  grantedAt DateTime  @default(now())
  expiresAt DateTime?
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, sku])
}

model AssetDownload {
  id        String   @id @default(cuid())
  assetId   String
  fileId    String?                        // AssetFile, onDelete: SetNull
  userId    String?
  deviceId  String?
  ip        String?
  createdAt DateTime @default(now())

  user   User?   @relation(fields: [userId], references: [id])
  device Device? @relation(fields: [deviceId], references: [id])

  @@index([assetId, createdAt(sort: Desc)])
  @@index([deviceId, createdAt(sort: Desc)])
}

model AssetFavorite {
  id        String   @id @default(cuid())
  assetId   String
  userId    String?
  deviceId  String?
  createdAt DateTime @default(now())

  user   User?   @relation(fields: [userId], references: [id])
  device Device? @relation(fields: [deviceId], references: [id])

  @@unique([assetId, deviceId])
  @@unique([assetId, userId])
}
```

`Device` is the load-bearing piece. The app has no users but it certainly has installs,
so everything needing an identity today — the download ledger, rate limits, favorites,
analytics — keys off the device and works with zero login. When accounts ship, signup
attaches existing devices to a new user and history comes with it. No migration, no loss.

## 6. Architecture

### 6.1 Module layout

```
src/
  core/        prisma · crypto · settings · storage · queue · cache · audit · errors · pagination
  modules/
    auth/      admin identity, tokens, guards
    assets/    base domain + kinds/{audio,font,template}
    taxonomy/  categories · collections · tags · licenses
    ingest/    upload tickets, finalize, processors
    delivery/  public read API + signed downloads
    identity/  device · user · entitlement
    releases/  app update + remote config
    system/    settings · storage providers
    admin/     controllers composing the above
```

`core/` has no feature dependencies; features depend inward only.

### 6.2 The asset kind registry

The generic asset service never switches on `kind`. Each kind module registers a
descriptor at boot through a DI multi-provider token:

```ts
interface AssetKindDescriptor {
  kind: AssetKind;
  label: string;
  accepts: { mimeTypes: string[]; extensions: string[]; maxBytesSetting: string };
  fileRoles: Array<{ role: FileRole; required: boolean; multiple: boolean }>;
  detailDto: Type<unknown>;
  processors: string[];          // queue job names, run in order after finalize
  toPublicDto(asset: AssetWithRelations): PublicAsset;
}
```

Consequences: adding stickers or LUTs later is one module plus one migration, with no
edits to ingest, delivery, search, or admin CRUD. `GET /admin/v1/kinds` returns the
descriptors, so a future dashboard can render a correct upload form for a kind it was
never coded against.

### 6.3 Storage abstraction

```ts
interface StorageProviderAdapter {
  readonly id: string;
  readonly kind: StorageKind;
  createUploadTicket(input: UploadTicketInput): Promise<UploadTicket>;
  verifyUpload(key: string): Promise<RemoteObject>;   // authoritative metadata
  getDeliveryUrl(key: string, opts?: DeliveryOpts): string;
  getSignedUrl(key: string, ttlSeconds: number): Promise<string>;
  delete(key: string): Promise<void>;
}
```

Two implementations cover the field: `CloudinaryAdapter` and `S3CompatibleAdapter`
(which is equally R2, B2, and Wasabi). A registry instantiates adapters from the
`StorageProvider` table and re-instantiates on config change.

`verifyUpload` closes the trust hole in the current code: finalize takes duration, byte
size, format, and checksum from the **provider**, never from the client.

### 6.4 Settings and secrets

Secrets use AES-256-GCM envelope encryption. Each record stores `{ iv, authTag,
ciphertext }` plus a `keyVersion`, so the master key can be rotated by re-wrapping
rather than by downtime.

A typed registry declares every setting in code — `type`, `default`, `scope`, `secret`,
validator — while values live in the database. Values are DB-owned; the schema is
code-owned. That is what keeps "the admin can change anything" from meaning "the admin
can brick the server with a typo."

The admin API returns secrets **masked** (`sk_live_••••4f2a`) and write-only: an admin
may replace a credential but never read one back. Reads are cached in Redis and
in-process, invalidated across instances by Redis pub/sub.

### 6.5 Ingest pipeline

1. **Ticket** — admin declares kind, filename, size, MIME. The server validates against
   the kind descriptor and current settings caps, creates a `draft` asset and an
   `UploadSession`, and returns a scoped, expiring ticket from the active default provider.
2. **Direct upload** — bytes go client → provider. The container never handles file data.
3. **Finalize** — `verifyUpload`, write `AssetFile` rows from provider-reported metadata,
   move the asset to `processing`, enqueue the kind's processors. Idempotent via the
   upload session.
4. **Processors (BullMQ)** —
   - audio: transcode preview, generate waveform peaks, extract duration/BPM
   - font: parse with fontkit for family/weights/scripts/glyph coverage, render a specimen
   - template: validate the project document against its engine schema, resolve
     dependencies, extract a poster frame
   - all kinds: checksum, dedupe check, thumbnail

   Success → `ready`. Failure → `failed` with the error recorded and surfaced in admin.
5. **Publish** — an explicit admin action → `published`, `publishedAt` set, caches
   invalidated, audit row written.

Two janitor jobs, boring and load-bearing:

- **Orphan reaper** — expires abandoned upload sessions; reconciles provider objects that
  have no DB row.
- **Deletion worker** — hard-deletes storage objects for soft-deleted assets after a
  retention window.

Without these, storage cost grows forever and nobody notices for a year.

## 7. Public API

Every request carries `X-SlimShot-Key` (per-platform app key), `X-Device-Id`, and
`X-App-Version`. The key is not a real secret — it ships in the binary — but it enables
revocation, per-platform rate limiting, killing a bad build, and distinguishing Android
from iOS from beta.

```
GET  /api/v1/catalog/assets          ?kind&category&collection&tags&q&sort&cursor&limit
GET  /api/v1/catalog/assets/:idOrSlug
GET  /api/v1/catalog/categories      ?kind          → tree
GET  /api/v1/catalog/collections     /:slug
GET  /api/v1/catalog/tags            ?kind          → filter chips
POST /api/v1/catalog/assets/:id/download            → short-lived signed URL
POST /api/v1/catalog/assets/:id/favorite   DELETE …
GET  /api/v1/me/favorites
POST /api/v1/devices/register
GET  /api/v1/app/config              ?platform&version
GET  /api/v1/app/update              ?platform&channel
```

Thin aliases generated from the kind registry — `/api/v1/audio`, `/api/v1/fonts`,
`/api/v1/templates` — bind `kind` and share the handler.

### 7.1 Deliberate changes from the current API

Nothing consumes the existing public API (verified: no reference to `api/v1/audio`,
`download_url`, or `preview_url` anywhere in the Flutter `lib/`), so the contract is
free to change.

- **Cursor pagination** replaces `page`/`limit`. Offset paging duplicates and skips rows
  when items are published mid-scroll, which is what mobile infinite scroll does all day.
  `meta` still carries an estimated total for UI.
- **camelCase** replaces `snake_case`.
- **No download URL in list responses.** Previews stay permanent public CDN URLs so
  browsing is fast and edge-cacheable; only `POST …/download` issues a signed expiring
  URL, and that is where the entitlement check, the `AssetDownload` ledger row, and the
  counter increment live.

### 7.2 Response envelope

Success keeps the existing `{ success, data, meta }` shape. Assets:

```jsonc
{
  "id": "…", "slug": "cinematic-rise", "kind": "audio",
  "title": "Cinematic Rise", "author": "SlimShot Library",
  "category": { "id": "cinematic", "name": "Cinematic" },
  "tags": ["epic", "trailer"],
  "license": { "name": "SlimShot Standard", "requiresAttribution": false },
  "files": {
    "preview":   { "url": "https://cdn…/preview.mp3", "byteSize": 812340 },
    "thumbnail": { "url": "https://cdn…/cover.jpg" },
    "waveform":  { "url": "https://cdn…/peaks.json" }
  },
  "detail": { "durationMs": 145000, "bpm": 120, "isLoopable": true },
  "stats": { "downloadCount": 91 }
}
```

`files` is a map keyed by role and `detail` is kind-specific, so the same envelope serves
fonts and templates without the client special-casing.

Errors use `{ success: false, error: { code, message, details?, traceId } }` with real
HTTP statuses. A global filter maps Prisma `P2002 → 409` and `P2025 → 404`, validation
→ 422, replacing the current catch-all 503.

## 8. Admin API

JWT bearer, 15-minute access / 7-day refresh. Three hardening requirements:

- **Refresh rotation with reuse detection** — presenting an already-revoked refresh token
  revokes the entire `familyId` lineage.
- **Login rate limiting with lockout.**
- **First-owner bootstrap** from env, self-disabling once `AdminUser` is non-empty.

Authorization uses `@RequirePermission('asset.publish')` decorators mapping permissions
to roles centrally — never `if (user.role === 'admin')` in controllers.

```
/auth/login · refresh · logout · me
/kinds                                   → descriptors; drives dynamic admin forms
/assets                                  ?kind&status&category&tag&q&sort&cursor
/assets/upload-ticket                    POST
/assets/:id/finalize                     POST
/assets/:id                              GET · PATCH · DELETE (soft)
/assets/:id/publish · unpublish · archive
/assets/:id/files                        POST · DELETE /:fileId
/assets/:id/dependents                   → what breaks if this is deleted
/assets/bulk                             publish · delete · tag · categorize
/categories · /collections               CRUD + reorder + move
/tags                                    GET · rename · merge · DELETE unused
/licenses                                CRUD
/stats/summary · timeseries · top-assets · top-tags · storage
/settings                                grouped; secrets masked, write-only
/storage-providers                       CRUD + POST :id/test-connection
/releases                                CRUD (app update channel)
/admins                                  CRUD (owner only)
/audit-logs                              GET
/jobs                                    queue health · failed jobs · retry
```

Asset endpoints are **generic over kind** — there is no `/admin/v1/audio`. One CRUD
surface, one permission model, one bulk implementation, for every kind ever added.

`test-connection` validates provider credentials before they are saved as default.
`/jobs` gives visibility into failed processing, which is necessary the moment ingestion
is asynchronous.

OpenAPI is generated by `@nestjs/swagger` at `/api/docs`, admin-gated in production.

## 9. Cross-cutting concerns

### 9.1 Caching

- **CDN** — catalog reads get `s-maxage=300, stale-while-revalidate=600`. File URLs are
  content-addressed by storage key, so `immutable, max-age=31536000`.
- **Redis** — keyed by normalized query. Invalidation uses a **generation counter per
  kind**: `catalog:gen:audio` is embedded in every audio cache key, and publishing an
  audio asset bumps it, orphaning every stale entry in O(1) with no key scanning.
- **In-process** — settings and kind descriptors only, invalidated by Redis pub/sub.

This replaces the current `@CacheTTL(60 * 60 * 24)` on search, under which a newly
uploaded track is invisible for a day.

### 9.2 Search

A generated `tsvector` on `Asset` weighting title **A**, tags **B**, author **C**,
description **D**, with a GIN index, plus `pg_trgm` for typo tolerance and prefix
matching. Ranking blends `ts_rank_cd` with download count and recency.

Because tags are a join table, the vector must be refreshed when tags change, in the same
transaction — implemented as a trigger, written deliberately rather than discovered.

Search sits behind a `CatalogSearchProvider` interface so Meilisearch could replace it
later. Do not build that now; Postgres FTS is correct well past the expected scale.

### 9.3 Observability and security

- Structured JSON logs (pino) with a request id surfaced as `traceId` in errors, and a
  redaction serializer so secrets cannot reach the log.
- `/health` (liveness) and `/health/ready` (DB, Redis, default storage provider).
- Prometheus `/metrics`: request duration, queue depth, job failure rate, cache hit rate,
  storage bytes.
- Helmet; CORS allowlist read from settings (not `enableCors()` with no arguments).
- Redis rate limiting keyed by app key, device, and IP.
- Payload caps enforced from settings.
- Every admin mutation writes an `AuditLog` row.

### 9.4 Testing

- **Unit** — slug generation, tag normalization, permission mapping, settings validation,
  encryption round-trip, version comparison.
- **Integration (primary layer)** — `Test.createTestingModule` against real Postgres, with
  storage and queue faked behind their interfaces. Use **Neon branching** for test
  databases: branch from a seeded baseline per CI run, discard after. This layer proves
  auth guards, RBAC, the ingest flow, and cache invalidation — all of which fail silently
  when verified by hand.
- **Contract** — snapshot the generated OpenAPI spec; CI flags accidental breaking changes.
- CI runs lint, typecheck, migrate, test, build. ESLint and Prettier do not currently
  exist in the repo and are added in Phase 0.

## 10. Build phases

| Phase | Scope | Exit condition |
|---|---|---|
| 0 | Baseline: commit working tree, baseline Prisma migration, ESLint/Prettier/CI, global error filter, delete dead DTOs | Clean repo, green CI |
| 1 | Core platform: crypto, `SystemSetting` + registry, `StorageProvider` + adapters, Redis cache, BullMQ, health, metrics, audit | Settings and providers editable via seed script; workers process a no-op job |
| 2 | Admin auth: `AdminUser`, roles, JWT + rotation + reuse detection, bootstrap, guards, login rate limit | Protected route rejects missing/expired/reused tokens |
| 3 | Asset core + audio: `Asset`/`AssetFile`/`UploadSession`, dormant `User`/`UserEntitlement`, kind registry, ingest, audio processors, admin CRUD, publish lifecycle | Feature parity with today's server, properly |
| 4 | Taxonomy: category tree, collections, normalized tags with rename/merge/cleanup, licenses | Hardcoded categories and duplicated tag vocabularies retired |
| 5 | Public delivery: catalog read API, search, cache invalidation, signed downloads + ledger, `Device`, favorites | App can integrate |
| 6 | App services: `AppRelease`, `/app/update`, `/app/config` | Vercel function reduced to a proxy |
| 7 | Fonts | Adding the kind touches no shared module |
| 8 | Templates: dependency graph, engine schema versioning | Same |
| 9 | Stats, job visibility, OpenAPI polish | Dashboard-ready API |

Phases 7 and 8 are the real test of the design. If adding fonts requires touching ingest,
delivery, search, or admin CRUD, the kind registry has failed and gets fixed then.

Phase 2 is the phase that makes the server safe to deploy at all. Until it lands,
`POST /api/v1/audio/upload/sign` hands Cloudinary credentials to any caller.

## 11. Migration and cutover

**Existing data.** The two `AudioAsset` rows are June test records. Drop them and seed
fresh rather than writing a migration.

**Prisma history.** The schema was applied with `db push`; there is no `_prisma_migrations`
table and no `prisma/migrations` directory, though `prisma.config.ts` already points at
one. The first `migrate dev` will detect drift and offer to reset. Phase 0 baselines this
deliberately: generate an initial migration from the current schema, `migrate resolve
--applied`, then build Phase 1 on top.

**Vercel retirement.** The shipped app has
`https://slimshot-ai-update-api.vercel.app/api/update` compiled into a released build, so
every installed copy will keep calling it. After Phase 6, repoint the Vercel function at
`/api/v1/app/update` as a thin proxy — one source of truth immediately, Vercel reduced to
a forwarder. Delete the Vercel project only once a shipped app release points at the new
host and old installs have aged out.

The response shape must keep the exact field names and types the Dart model casts
(`latestVersion`, `latestBuildNumber`, `forceUpdate`, `title`, `releaseNotes`,
`updateUrl`, `minSupportedVersion`). `UpdateInfo.fromJson` uses unguarded `as String` /
`as int`, so a null or stringified number breaks update checks silently.

## 12. Deferred

- Creator/community publishing endpoints (model reserves `ownerId`, `visibility`,
  `moderationState`).
- Billing, purchase verification, receipt validation.
- User-facing auth endpoints.
- Meilisearch/Typesense behind `CatalogSearchProvider`.
- Multi-region storage replication.
- Admin dashboard frontend.
