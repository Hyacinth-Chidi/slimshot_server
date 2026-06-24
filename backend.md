# SlimShot Backend Architecture Guide

This document outlines the architecture and API contracts for the SlimShot backend. Built with **NestJS**, this backend serves as a secure proxy to Pixabay, implements caching to prevent rate-limit exhaustion, and provides a unified, structured JSON response that the Flutter application can easily consume.

## 1. Architectural Philosophy

To ensure the backend is scalable and ready for future modules (e.g., User Authentication, Video Processing, AI generation), adhere to the following NestJS best practices:

- **Modular Design:** Create a dedicated `AudioModule`. Do not pollute the `AppModule`.
- **Service Abstraction:** Use `@nestjs/axios` to make HTTP requests to third parties. Keep Pixabay logic inside a dedicated `PixabayService`.
- **Caching Layer:** Implement `@nestjs/cache-manager`. Cache frequent search queries (e.g., "cinematic background music") for 12-24 hours to drastically reduce the load on your external API quotas.
- **Unified Interface:** The Flutter app shouldn't care about Pixabay's raw response shape. The backend must normalize the data into a single standard format.

---

## 2. Recommended Module Structure

```text
src/
├── app.module.ts
├── common/
│   ├── interceptors/
│   │   └── cache.interceptor.ts
│   └── interfaces/
│       └── audio-track.interface.ts
└── modules/
    └── audio/
        ├── audio.module.ts
        ├── audio.controller.ts
        ├── audio.service.ts
        ├── providers/
        │   └── pixabay.service.ts
        └── dto/
            └── search-audio.dto.ts
```

---

## 3. Required API Endpoints

The Flutter app will expect the following endpoints to populate the Audio Drawer.

### A. Search Audio
**Endpoint:** `GET /api/v1/audio/search`

**Query Parameters:**
- `q` (string, optional) - The search term (e.g., "happy", "whoosh").
- `type` (string, optional) - `music` or `sfx`. Default is `music`.
- `page` (number, optional) - Pagination.
- `limit` (number, optional) - Results per page.

**The Golden Rule:** The response MUST be normalized. Regardless of Pixabay's raw payload, map it to this exact format so our Flutter app can parse it effortlessly:

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

### B. Get Categories/Genres
**Endpoint:** `GET /api/v1/audio/categories`

**Response:**
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

---

## 4. Implementation Steps for NestJS

1. **Install Dependencies:**
   ```bash
   npm install @nestjs/axios axios cache-manager @nestjs/cache-manager
   ```

2. **Configure Environment Variables:**
   Keep your API keys in a `.env` file. Do not hardcode them.
   ```env
   PIXABAY_API_KEY=your_key_here
   ```

3. **Implement Caching in the Controller:**
   Use the built-in cache interceptor to cache identical searches.
   ```typescript
   import { Controller, Get, Query, UseInterceptors } from '@nestjs/common';
   import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';

   @Controller('api/v1/audio')
   @UseInterceptors(CacheInterceptor)
   export class AudioController {
     constructor(private readonly audioService: AudioService) {}

     @Get('search')
     @CacheTTL(86400000) // Cache for 24 hours
     async searchAudio(@Query() query: SearchAudioDto) {
       return this.audioService.search(query);
     }
   }
   ```

4. **Normalize the Data in the Provider:**
   When you fetch from Pixabay, map their keys to our agreed format.
   ```typescript
   // Inside PixabayService.ts
   private mapToUnifiedFormat(pixabayData: any): AudioTrack {
     return {
       id: `pixabay-${pixabayData.id}`,
       title: pixabayData.name,
       author: pixabayData.userName,
       duration_seconds: pixabayData.duration,
       preview_url: pixabayData.preview,
       download_url: pixabayData.download,
       type: 'music',
       source: 'pixabay',
       tags: pixabayData.tags.split(', ')
     };
   }
   ```

## Next Steps

Once you have the NestJS server running (even locally on `http://localhost:3000`), provide me with the base URL. I will then immediately integrate the network layer into our Flutter app, set up the parsing models, and map it straight into our Audio Drawer!
