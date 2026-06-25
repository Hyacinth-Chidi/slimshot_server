# SlimShot Server

NestJS backend for SlimShot.

This service stores audio metadata in Neon Postgres through Prisma and stores the uploaded audio files in Cloudinary. The API exposes a normalized audio catalog for the client app and includes a temporary browser upload page for development.

## Features

- NestJS backend with modular `AudioModule`
- Prisma ORM with Neon Postgres for audio metadata
- Cloudinary-backed audio file storage
- Audio upload endpoint that stores files in Cloudinary and metadata in Postgres
- Temporary HTML upload page for asset management before the real frontend exists
- Normalized API response shape for the Flutter client
- Built-in request validation
- Cached search responses with `@nestjs/cache-manager`

## Tech Stack

- NestJS
- TypeScript
- Prisma ORM
- Neon Postgres
- Axios via `@nestjs/axios`
- Cloudinary
- `@nestjs/config`
- `@nestjs/cache-manager`
- `class-validator`

## Project Structure

```text
src/
├── app.module.ts
├── main.ts
├── common/
│   └── interfaces/
│       └── audio-track.interface.ts
└── modules/
    └── audio/
        ├── audio.module.ts
        ├── audio.controller.ts
        ├── audio.service.ts
        ├── dto/
        │   └── search-audio.dto.ts
        │   └── upload-audio.dto.ts
        └── providers/
            └── cloudinary-audio.service.ts
```

## Requirements

- Node.js 20+
- npm
- Neon Postgres database
- Cloudinary account

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create a local env file:

```bash
copy .env.example .env
```

3. Fill in `.env` with your Neon and Cloudinary credentials:

```env
PORT=3000
DATABASE_URL="postgresql://username:password@your-neon-pooler-host/database?sslmode=require&channel_binding=require"
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
CLOUDINARY_AUDIO_FOLDER=slimshot/audio
```

4. Generate the Prisma client:

```bash
npm run prisma:generate
```

5. Push the schema to Neon:

```bash
npx prisma db push
```

6. Start the app:

```bash
npm run start:dev
```

If you prefer a one-time production-style start after building:

```bash
npm run build
npm run start:prod
```

## Run

Development:

```bash
npm run start:dev
```

Local start without watch:

```bash
npm run start
```

Build:

```bash
npm run build
```

Production:

```bash
npm run start:prod
```

## API Base URL

Local default:

```text
http://localhost:3000
```

## Endpoints

### `GET /api/v1/audio/search`

Lists audio records from Neon Postgres and returns the normalized payload used by the client app.

Query parameters:

- `q` optional search term like `happy`, `cinematic`, or `whoosh`
- `type` optional `music` or `sfx`, default is `music`
- `page` optional page number, default is `1`
- `limit` optional page size, default is `20`

Example:

```bash
curl "http://localhost:3000/api/v1/audio/search?q=cinematic&type=music&page=1&limit=10"
```

Response shape:

```json
{
  "success": true,
  "data": [
    {
      "id": "cmc123example",
      "title": "Cinematic Epic Trailer",
      "author": "SlimShot Library",
      "duration_seconds": 145,
      "preview_url": "https://res.cloudinary.com/your-cloud/video/upload/...",
      "download_url": "https://res.cloudinary.com/your-cloud/video/upload/...",
      "type": "music",
      "source": "cloudinary",
      "tags": ["cinematic", "epic", "trailer"]
    }
  ],
  "meta": {
    "total_results": 1500,
    "page": 1,
    "has_more": true
  }
}
```

### `GET /api/v1/audio/categories`

Returns fixed music and SFX categories for the client UI.

Example:

```bash
curl "http://localhost:3000/api/v1/audio/categories"
```

Response shape:

```json
{
  "success": true,
  "data": [
    { "id": "cinematic", "name": "Cinematic", "type": "music" },
    { "id": "ambient", "name": "Ambient", "type": "music" },
    { "id": "transitions", "name": "Transitions", "type": "sfx" }
  ]
}
```

### `GET /api/v1/audio/upload`

Returns a temporary HTML upload page for manually sending audio files to Cloudinary.

Open it in the browser:

```text
http://localhost:3000/api/v1/audio/upload
```

### `POST /api/v1/audio/upload`

Uploads an audio file to Cloudinary, then creates or updates the matching `AudioAsset` record in Neon through Prisma.

Multipart form fields:

- `file` required audio file
- `title` optional display title
- `author` optional author label
- `type` optional `music` or `sfx`
- `tags` optional comma-separated tags
- file type must be `audio/*`
- max file size is `50MB`

## Validation Rules

- `type` must be `music` or `sfx`
- `page` must be an integer greater than or equal to `1`
- `limit` must be an integer between `1` and `50`

## Notes

- Audio files are stored in Cloudinary using resource type `video`, which is how Cloudinary handles audio uploads.
- Audio metadata is stored in the `AudioAsset` table in Neon Postgres.
- Search requests are cached to reduce repeated database reads.
- The temporary upload page is meant only as a bridge until the real frontend is built.
- If `DATABASE_URL` is missing or invalid, Prisma cannot generate the client and the API cannot start correctly.
- If the Cloudinary credentials are missing, upload requests fail and audio asset creation cannot complete.
- Cover art should be embedded in the audio file metadata before upload instead of being uploaded separately.

## Prisma Workflow

Generate the client after schema changes:

```bash
npm run prisma:generate
```

Sync the schema to Neon during development:

```bash
npx prisma db push
```

Open Prisma Studio if you want to inspect records locally:

```bash
npm run prisma:studio
```

## Related Docs

- Architecture guide: `backend.md`
