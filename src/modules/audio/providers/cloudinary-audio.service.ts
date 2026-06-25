import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';

import type { AudioType } from '../../../common/interfaces/audio-track.interface';
import { CreateAudioUploadSignatureDto } from '../dto/create-audio-upload-signature.dto';
import { FinalizeAudioUploadDto } from '../dto/finalize-audio-upload.dto';

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

export interface DirectAudioUploadSignature {
  uploadUrl: string;
  apiKey: string;
  cloudName: string;
  timestamp: number;
  signature: string;
  folder: string;
  title: string;
  author: string;
  type: AudioType;
  tags: string[];
  cloudinaryTags: string[];
}

@Injectable()
export class CloudinaryAudioService {
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

  createDirectUploadSignature(
    payload: CreateAudioUploadSignatureDto,
  ): DirectAudioUploadSignature {
    if (!this.isConfigured()) {
      throw new Error('Cloudinary is not configured.');
    }

    const title =
      payload.title?.trim() ||
      this.formatDetectedTitle(this.stripExtension(payload.originalFilename));
    const author = payload.author?.trim() || 'SlimShot';
    const type = payload.type ?? 'music';
    const tags = this.normalizeTagList(payload.tags);
    const cloudinaryTags = this.buildTags(tags, type, author);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = cloudinary.utils.api_sign_request(
      {
        folder: this.folder,
        timestamp,
        display_name: title,
        tags: cloudinaryTags.join(','),
        use_filename: 'true',
        unique_filename: 'true',
        overwrite: 'false',
      },
      this.apiSecret as string,
    );

    return {
      uploadUrl: `https://api.cloudinary.com/v1_1/${this.cloudName}/video/upload`,
      apiKey: this.apiKey as string,
      cloudName: this.cloudName as string,
      timestamp,
      signature,
      folder: this.folder,
      title,
      author,
      type,
      tags,
      cloudinaryTags,
    };
  }

  getUploadPageHtml(): string {
    const signUrl = '/api/v1/audio/upload/sign';
    const finalizeUrl = '/api/v1/audio/upload';
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
        <p>Temporary admin page for uploading audio directly to Cloudinary, then saving the searchable record in Postgres.</p>
        <div class="pill-row">
          <span class="pill">Direct browser upload</span>
          <span class="pill">Cloudinary signed upload</span>
          <span class="pill">Accepted: audio/*</span>
        </div>
      </div>

      <div class="grid">
        <div class="card">
          <h2>Upload Track</h2>
          <p class="muted">The browser uploads the file directly to Cloudinary. After that succeeds, the backend saves the audio metadata in Postgres through Prisma.</p>
          <form id="upload-form">
            <label for="file">Audio File</label>
            <input id="file" name="file" type="file" accept="audio/*" required>
            <div class="hint">Cloudinary stores audio under resource type "video". Embed artwork in the MP3 before upload if you want one asset instead of separate image URLs.</div>

            <label for="title">Title</label>
            <input id="title" name="title" type="text" placeholder="Epic Trailer">
            <div class="hint">Leave this blank to auto-fill from the selected file name.</div>

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
      const authorInput = document.getElementById('author');
      const typeInput = document.getElementById('type');
      const tagsSelect = document.getElementById('tags');
      const customTagsInput = document.getElementById('custom-tags');
      const preview = document.getElementById('audio-preview');
      const resultLink = document.getElementById('result-link');
      const musicTagOptions = ${musicTagOptions};
      const sfxTagOptions = ${sfxTagOptions};
      const signUrl = '${signUrl}';
      const finalizeUrl = '${finalizeUrl}';

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

      function collectTags() {
        const presetTags = Array.from(tagsSelect.selectedOptions).map((option) => option.value);
        const customTags = customTagsInput.value
          .split(',')
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean);

        return Array.from(new Set([...presetTags, ...customTags]));
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
        const file = fileInput.files && fileInput.files[0];

        if (!file) {
          status.textContent = 'Choose an audio file first.';
          status.className = 'error';
          result.textContent = 'Audio file is required.';
          return;
        }

        submitButton.disabled = true;
        status.textContent = 'Signing upload...';
        status.className = 'muted';
        result.textContent = 'Uploading...';
        resultLink.textContent = '';
        preview.hidden = true;
        preview.removeAttribute('src');

        try {
          const signResponse = await fetch(signUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              originalFilename: file.name,
              mimeType: file.type || 'application/octet-stream',
              fileSizeBytes: file.size,
              title: titleInput.value.trim(),
              author: authorInput.value.trim(),
              type: typeInput.value,
              tags: collectTags(),
            }),
          });

          const signPayload = await signResponse.json().catch(() => null);

          if (!signResponse.ok || !signPayload || !signPayload.data) {
            const message =
              signPayload && signPayload.message
                ? Array.isArray(signPayload.message)
                  ? signPayload.message.join(', ')
                  : signPayload.message
                : 'Could not prepare the Cloudinary upload.';

            throw new Error(message);
          }

          const signedUpload = signPayload.data;
          const cloudinaryForm = new FormData();
          cloudinaryForm.append('file', file);
          cloudinaryForm.append('api_key', signedUpload.apiKey);
          cloudinaryForm.append('timestamp', String(signedUpload.timestamp));
          cloudinaryForm.append('signature', signedUpload.signature);
          cloudinaryForm.append('folder', signedUpload.folder);
          cloudinaryForm.append('display_name', signedUpload.title);
          cloudinaryForm.append('tags', signedUpload.cloudinaryTags.join(','));
          cloudinaryForm.append('use_filename', 'true');
          cloudinaryForm.append('unique_filename', 'true');
          cloudinaryForm.append('overwrite', 'false');

          status.textContent = 'Uploading file to Cloudinary...';

          const cloudinaryResponse = await fetch(signedUpload.uploadUrl, {
            method: 'POST',
            body: cloudinaryForm,
          });

          const cloudinaryPayload = await cloudinaryResponse.json().catch(() => null);

          if (!cloudinaryResponse.ok || !cloudinaryPayload) {
            const message =
              cloudinaryPayload && cloudinaryPayload.error && cloudinaryPayload.error.message
                ? cloudinaryPayload.error.message
                : 'Cloudinary upload failed.';

            throw new Error(message);
          }

          status.textContent = 'Saving audio record...';

          const finalizeResponse = await fetch(finalizeUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              assetId: cloudinaryPayload.asset_id || null,
              publicId: cloudinaryPayload.public_id,
              originalFilename: file.name,
              title: signedUpload.title,
              author: signedUpload.author,
              durationSeconds: Math.round(cloudinaryPayload.duration || 0),
              previewUrl: cloudinaryPayload.secure_url,
              downloadUrl: cloudinaryPayload.secure_url,
              type: signedUpload.type,
              tags: signedUpload.tags,
              mimeType: file.type || 'application/octet-stream',
              fileSizeBytes: cloudinaryPayload.bytes || file.size,
            }),
          });

          const payload = await finalizeResponse.json().catch(() => null);

          if (!finalizeResponse.ok) {
            const message =
              payload && payload.message
                ? Array.isArray(payload.message)
                  ? payload.message.join(', ')
                  : payload.message
                : 'Could not save the uploaded audio record.';

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

  mapDirectUploadResult(
    payload: FinalizeAudioUploadDto,
  ): UploadedCloudinaryAudioAsset {
    return {
      assetId: payload.assetId ?? null,
      publicId: payload.publicId,
      originalFilename: payload.originalFilename,
      title: payload.title,
      author: payload.author,
      durationSeconds: payload.durationSeconds,
      previewUrl: payload.previewUrl,
      downloadUrl: payload.downloadUrl,
      type: payload.type,
      tags: this.cleanTags(
        this.buildTags(payload.tags, payload.type, payload.author),
      ),
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

  private normalizeTagList(tags: string[]): string[] {
    return Array.from(
      new Set(
        tags
          .map((tag) => tag.trim().toLowerCase())
          .filter(Boolean),
      ),
    );
  }

  private cleanTags(tags: string[]): string[] {
    return Array.from(
      new Set(
        tags.filter(
          (tag) =>
            tag !== 'slimshot-audio' &&
            !tag.startsWith('audio-type:') &&
            !tag.startsWith('author:'),
        ),
      ),
    );
  }

  private formatDetectedTitle(value: string): string {
    return value.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private stripExtension(fileName: string): string {
    return fileName.replace(/\.[^.]+$/, '').trim();
  }

  private isConfigured(): boolean {
    return Boolean(this.cloudName && this.apiKey && this.apiSecret);
  }
}
