# SlimShot Server

NestJS backend for SlimShot.

This service currently provides audio search and category endpoints backed by Pixabay. It normalizes Pixabay responses into a consistent JSON format that the Flutter app can consume directly.

## Features

- NestJS backend with modular `AudioModule`
- Pixabay-backed audio search
- Normalized API response shape for the Flutter client
- Built-in request validation
- Cached search responses with `@nestjs/cache-manager`

## Tech Stack

- NestJS
- TypeScript
- Axios via `@nestjs/axios`
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
        └── providers/
            └── pixabay.service.ts
```

## Requirements

- Node.js 18+
- npm
- Pixabay API key

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create a `.env` file from `.env.example`.

3. Add your Pixabay API key:

```env
PORT=3000
PIXABAY_API_KEY=your_pixabay_api_key
PIXABAY_BASE_URL=https://pixabay.com/api/
```

## Run

Development:

```bash
npm run start:dev
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

Searches Pixabay audio and returns normalized results.

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
      "id": "pixabay-12345",
      "title": "Cinematic Epic Trailer",
      "author": "JohnDoeBeats",
      "duration_seconds": 145,
      "preview_url": "https://pixabay.com/audio/preview/12345.mp3",
      "download_url": "https://pixabay.com/audio/download/12345.mp3",
      "type": "music",
      "source": "pixabay",
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

## Validation Rules

- `type` must be `music` or `sfx`
- `page` must be an integer greater than or equal to `1`
- `limit` must be an integer between `1` and `50`

## Notes

- Search requests are cached to reduce repeated calls to Pixabay.
- The backend only uses Pixabay right now.
- If `PIXABAY_API_KEY` is missing, the search endpoint returns a service configuration error.

## Related Docs

- Architecture guide: `backend.md`
