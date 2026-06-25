import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';
import { parseBuffer } from 'music-metadata';

import type { AudioType } from '../../../common/interfaces/audio-track.interface';
import { UploadAudioDto } from '../dto/upload-audio.dto';
import { UploadedAudioFile } from '../interfaces/uploaded-audio-file.interface';

const MUSIC_TAG_OPTIONS = [
  'cinematic',
  'ambient',
  'corporate',
  'lofi',
  'trailer',
  'dramatic',
  'uplifting',
  'emotional',
];

const SFX_TAG_OPTIONS = [
  'transitions',
  'whoosh',
  'impacts',
  'ui',
  'riser',
  'hit',
  'glitch',
  'sweep',
];

export interface UploadedCloudinaryAudioAsset {
  assetId: string | null;
  publicId: string;
  originalFilename: string;
  title: string;
  author: string;
  durationSeconds: number;
  previewUrl: string;
  downloadUrl: string;
  type: AudioType;
  tags: string[];
}

@Injectable()
export class CloudinaryAudioService {
  private readonly logger = new Logger(CloudinaryAudioService.name);
  private readonly cloudName?: string;
  private readonly apiKey?: string;
  private readonly apiSecret?: string;
  private readonly folder: string;

  constructor(private readonly configService: ConfigService) {
    this.cloudName = this.configService.get<string>('CLOUDINARY_CLOUD_NAME');
    this.apiKey = this.configService.get<string>('CLOUDINARY_API_KEY');
    this.apiSecret = this.configService.get<string>('CLOUDINARY_API_SECRET');
    this.folder =
      this.configService.get<string>('CLOUDINARY_AUDIO_FOLDER') ??
      'slimshot/audio';

    if (this.isConfigured()) {
      cloudinary.config({
        cloud_name: this.cloudName,
        api_key: this.apiKey,
        api_secret: this.apiSecret,
        secure: true,
      });
    }
  }

  async uploadAudio(
    file: UploadedAudioFile,
    payload: UploadAudioDto,
  ): Promise<UploadedCloudinaryAudioAsset> {
    if (!this.isConfigured()) {
      throw new Error('Cloudinary is not configured.');
    }

    const metadata = await this.extractAudioMetadata(file);
    const title =
      payload.title?.trim() ||
      metadata.title ||
      this.formatDetectedTitle(this.stripExtension(file.originalname));
    const author = payload.author?.trim() || metadata.artist || 'SlimShot';
    const type = payload.type ?? 'music';
    const inputTags = [...payload.tags, ...metadata.genres];
    const tags = this.buildTags(inputTags, type, author);

    const result = await new Promise<UploadApiResponse>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'video',
          folder: this.folder,
          display_name: title,
          use_filename: true,
          unique_filename: true,
          overwrite: false,
          tags,
        },
        (error, uploadResult) => {
          if (error || !uploadResult) {
            reject(error ?? new Error('Cloudinary upload failed.'));
            return;
          }

          resolve(uploadResult);
        },
      );

      stream.end(file.buffer);
    });

    return this.mapUploadResult(result, type, author, inputTags);
  }

  getUploadPageHtml(): string {
    const actionUrl = '/api/v1/audio/upload';
    const musicTagOptions = JSON.stringify(MUSIC_TAG_OPTIONS);
    const sfxTagOptions = JSON.stringify(SFX_TAG_OPTIONS);

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>SlimShot Audio Upload</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body { font-family: Arial, sans-serif; background: linear-gradient(180deg, #020617 0%, #0f172a 100%); color: #e2e8f0; margin: 0; padding: 32px 20px; }
      .wrap { max-width: 900px; margin: 0 auto; display: grid; gap: 20px; }
      .card { background: rgba(15, 23, 42, 0.86); border: 1px solid #1e293b; border-radius: 18px; padding: 24px; box-shadow: 0 18px 50px rgba(2, 6, 23, 0.35); }
      h1, h2 { margin: 0 0 12px; }
      p { color: #cbd5e1; margin: 0 0 10px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
      label { display: block; margin: 16px 0 8px; font-weight: 600; }
      input, select, button { width: 100%; border-radius: 12px; border: 1px solid #334155; background: #0f172a; color: #e2e8f0; padding: 12px; }
      input[type="file"] { padding: 10px; }
      select[multiple] { min-height: 180px; }
      button { background: #2563eb; border: 0; cursor: pointer; font-weight: 700; margin-top: 20px; }
      button:hover { background: #1d4ed8; }
      button:disabled { opacity: 0.65; cursor: wait; }
      .hint { font-size: 14px; color: #94a3b8; margin-top: 6px; }
      .muted { color: #94a3b8; font-size: 14px; }
      .pill-row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; }
      .pill { display: inline-flex; align-items: center; padding: 8px 12px; border-radius: 999px; background: #0f172a; border: 1px solid #334155; color: #cbd5e1; font-size: 14px; }
      pre { white-space: pre-wrap; background: #020617; color: #93c5fd; padding: 16px; border-radius: 12px; min-height: 180px; overflow: auto; }
      audio { width: 100%; margin-top: 14px; }
      .success { color: #86efac; }
      .error { color: #fca5a5; }
      a { color: #93c5fd; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>SlimShot Audio Upload</h1>
        <p>Temporary admin page for uploading audio into Cloudinary before the separate frontend is built.</p>
        <div class="pill-row">
          <span class="pill">POST ${actionUrl}</span>
          <span class="pill">Max file size: 50MB</span>
          <span class="pill">Accepted: audio/*</span>
        </div>
      </div>

      <div class="grid">
        <div class="card">
          <h2>Upload Track</h2>
          <p class="muted">Upload a single audio file that already contains any embedded cover art metadata. The backend stores the file in Cloudinary and the searchable metadata in Postgres.</p>
          <form id="upload-form" action="${actionUrl}" method="post" enctype="multipart/form-data">
            <label for="file">Audio File</label>
            <input id="file" name="file" type="file" accept="audio/*" required>
            <div class="hint">Cloudinary stores audio under resource type "video". Embed artwork in the MP3 before upload if you want one asset instead of separate image URLs.</div>

            <label for="title">Title</label>
            <input id="title" name="title" type="text" placeholder="Epic Trailer">
            <div class="hint">Leave this blank to auto-fill from embedded audio metadata or the file name.</div>

            <label for="author">Author</label>
            <input id="author" name="author" type="text" placeholder="SlimShot Library">

            <label for="type">Type</label>
            <select id="type" name="type">
              <option value="music">music</option>
              <option value="sfx">sfx</option>
            </select>

            <label for="tags">Common Tags</label>
            <select id="tags" name="tags" multiple></select>
            <div class="hint">Pick one or more preset tags. Hold Ctrl on Windows or Cmd on macOS to select multiple tags.</div>

            <label for="custom-tags">Extra Tags</label>
            <input id="custom-tags" name="tags" type="text" placeholder="custom tags, comma separated">
            <div class="hint">Optional extra tags. Example: epic, suspense, clean-piano</div>

            <button id="submit-button" type="submit">Upload To Cloudinary</button>
          </form>
        </div>

        <div class="card">
          <h2>Result</h2>
          <p id="status" class="muted">Submit the form to upload an audio file.</p>
          <audio id="audio-preview" controls hidden></audio>
          <p id="result-link" class="muted"></p>
          <pre id="result">No upload yet.</pre>
        </div>
      </div>
    </div>

    <script>
      const form = document.getElementById('upload-form');
      const result = document.getElementById('result');
      const status = document.getElementById('status');
      const submitButton = document.getElementById('submit-button');
      const fileInput = document.getElementById('file');
      const titleInput = document.getElementById('title');
      const typeInput = document.getElementById('type');
      const tagsSelect = document.getElementById('tags');
      const preview = document.getElementById('audio-preview');
      const resultLink = document.getElementById('result-link');
      const musicTagOptions = ${musicTagOptions};
      const sfxTagOptions = ${sfxTagOptions};

      function detectTitleFromFileName(fileName) {
        return fileName
          .replace(/\\.[^.]+$/, '')
          .replace(/[-_]+/g, ' ')
          .replace(/\\s+/g, ' ')
          .trim();
      }

      function renderTagOptions() {
        const selectedValues = Array.from(tagsSelect.selectedOptions).map((option) => option.value);
        const options = typeInput.value === 'sfx' ? sfxTagOptions : musicTagOptions;

        tagsSelect.innerHTML = '';

        options.forEach((value) => {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = value;
          option.selected = selectedValues.includes(value);
          tagsSelect.appendChild(option);
        });
      }

      fileInput.addEventListener('change', () => {
        const file = fileInput.files && fileInput.files[0];

        if (!file) {
          return;
        }

        status.textContent = 'Ready to upload: ' + file.name;
        status.className = 'muted';

        if (!titleInput.value.trim()) {
          titleInput.value = detectTitleFromFileName(file.name);
        }
      });

      typeInput.addEventListener('change', () => {
        renderTagOptions();
      });

      renderTagOptions();

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        submitButton.disabled = true;
        status.textContent = 'Uploading...';
        status.className = 'muted';
        result.textContent = 'Uploading...';
        resultLink.textContent = '';
        preview.hidden = true;
        preview.removeAttribute('src');

        try {
          const response = await fetch(form.action, {
            method: 'POST',
            body: new FormData(form),
          });

          const payload = await response.json().catch(() => null);

          if (!response.ok) {
            const message =
              payload && payload.message
                ? Array.isArray(payload.message)
                  ? payload.message.join(', ')
                  : payload.message
                : 'Upload failed.';

            throw new Error(message);
          }

          result.textContent = JSON.stringify(payload, null, 2);
          status.textContent = 'Upload complete.';
          status.className = 'success';

          const track = payload && payload.data ? payload.data : null;

          if (track && track.preview_url) {
            preview.src = track.preview_url;
            preview.hidden = false;
            resultLink.innerHTML = '<a href="' + track.preview_url + '" target="_blank" rel="noreferrer">Open uploaded asset</a>';
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Upload failed.';
          status.textContent = message;
          status.className = 'error';
          result.textContent = message;
        } finally {
          submitButton.disabled = false;
        }
      });
    </script>
  </body>
</html>`;
  }

  private mapUploadResult(
    result: UploadApiResponse,
    type: AudioType,
    author: string,
    inputTags: string[],
  ): UploadedCloudinaryAudioAsset {
    return {
      assetId: result.asset_id ?? null,
      publicId: result.public_id,
      originalFilename: result.original_filename ?? this.basename(result.public_id),
      title:
        result.display_name?.trim() ||
        result.original_filename?.trim() ||
        this.basename(result.public_id),
      author,
      durationSeconds: Math.round(result.duration ?? 0),
      previewUrl: result.secure_url,
      downloadUrl: result.secure_url,
      type,
      tags: this.cleanTags(this.buildTags(inputTags, type, author)),
    };
  }

  private buildTags(
    inputTags: string[],
    type: AudioType,
    author: string,
  ): string[] {
    const normalizedAuthor = author
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    return [
      'slimshot-audio',
      `audio-type:${type}`,
      `author:${normalizedAuthor || 'slimshot'}`,
      ...inputTags
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean),
    ];
  }

  private cleanTags(tags: string[]): string[] {
    return tags.filter(
      (tag) =>
        tag !== 'slimshot-audio' &&
        !tag.startsWith('audio-type:') &&
        !tag.startsWith('author:'),
    );
  }

  private async extractAudioMetadata(
    file: UploadedAudioFile,
  ): Promise<{ title?: string; artist?: string; genres: string[] }> {
    try {
      const metadata = await parseBuffer(
        file.buffer,
        {
          mimeType: file.mimetype,
          size: file.size,
        },
        {
          skipCovers: true,
        },
      );

      return {
        title: metadata.common.title?.trim() || undefined,
        artist: metadata.common.artist?.trim() || undefined,
        genres:
          metadata.common.genre
            ?.map((entry) => entry.trim().toLowerCase())
            .filter(Boolean) ?? [],
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unable to parse metadata.';

      this.logger.debug(`Audio metadata detection skipped: ${message}`);

      return {
        genres: [],
      };
    }
  }

  private formatDetectedTitle(value: string): string {
    return value.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private stripExtension(fileName: string): string {
    return fileName.replace(/\.[^.]+$/, '').trim();
  }

  private basename(publicId: string): string {
    const value = publicId.split('/').pop() ?? publicId;
    return value.replace(/[-_]+/g, ' ').trim();
  }

  private isConfigured(): boolean {
    return Boolean(this.cloudName && this.apiKey && this.apiSecret);
  }
}
