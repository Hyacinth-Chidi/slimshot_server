import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

import {
  AudioTrack,
  AudioType,
} from '../../../common/interfaces/audio-track.interface';
import { SearchAudioDto } from '../dto/search-audio.dto';

interface ProviderSearchResult {
  data: AudioTrack[];
  total: number;
  configured: boolean;
  successful: boolean;
}

type PixabayHit = Record<string, unknown>;

interface PixabayResponse {
  total?: number;
  totalHits?: number;
  hits?: PixabayHit[];
}

@Injectable()
export class PixabayService {
  private readonly logger = new Logger(PixabayService.name);
  private readonly apiKey?: string;
  private readonly baseUrl: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.apiKey = this.configService.get<string>('PIXABAY_API_KEY');
    this.baseUrl =
      this.configService.get<string>('PIXABAY_BASE_URL') ??
      'https://pixabay.com/api/';
  }

  async search(query: SearchAudioDto): Promise<ProviderSearchResult> {
    if (!this.apiKey) {
      this.logger.warn('PIXABAY_API_KEY is not configured. Skipping Pixabay.');
      return { data: [], total: 0, configured: false, successful: false };
    }

    try {
      const response = await firstValueFrom(
        this.httpService.get<PixabayResponse>(this.baseUrl, {
          params: {
            key: this.apiKey,
            q: this.buildQuery(query.q, query.type),
            page: query.page,
            per_page: query.limit,
            category: 'music',
            safesearch: true,
            order: 'popular',
          },
        }),
      );

      const payload = response.data;
      const items = Array.isArray(payload.hits) ? payload.hits : [];

      return {
        data: items
          .map((item) => this.mapToUnifiedFormat(item, query.type))
          .filter((item): item is AudioTrack => item !== null),
        total: payload.totalHits ?? payload.total ?? items.length,
        configured: true,
        successful: true,
      };
    } catch (error) {
      this.logger.error('Pixabay search failed', error);
      return { data: [], total: 0, configured: true, successful: false };
    }
  }

  private buildQuery(rawQuery: string | undefined, type: AudioType): string {
    const baseQuery = rawQuery?.trim() || (type === 'music' ? 'background music' : 'sound effect');
    return type === 'music' ? baseQuery : `${baseQuery} sound effect`;
  }

  private mapToUnifiedFormat(
    pixabayData: PixabayHit,
    type: AudioType,
  ): AudioTrack | null {
    const rawId = this.readStringOrNumber(pixabayData.id);
    const title =
      this.readString(pixabayData.name) ??
      this.readString(pixabayData.title) ??
      this.readString(pixabayData.tags) ??
      'Untitled track';
    const author =
      this.readString(pixabayData.userName) ??
      this.readString(pixabayData.user) ??
      'Unknown author';
    const duration = this.readNumber(pixabayData.duration) ?? 0;
    const previewUrl =
      this.readString(pixabayData.previewURL) ??
      this.readString(pixabayData.preview) ??
      this.readNestedString(pixabayData, ['previews', 'preview-hq-mp3']) ??
      this.readNestedString(pixabayData, ['previews', 'preview-lq-mp3']);
    const downloadUrl =
      this.readString(pixabayData.downloadURL) ??
      this.readString(pixabayData.download) ??
      this.readString(pixabayData.url) ??
      previewUrl;

    if (!rawId || !previewUrl || !downloadUrl) {
      return null;
    }

    return {
      id: `pixabay-${rawId}`,
      title,
      author,
      duration_seconds: Math.round(duration),
      preview_url: previewUrl,
      download_url: downloadUrl,
      type,
      source: 'pixabay',
      tags: this.extractTags(pixabayData.tags),
    };
  }

  private extractTags(value: unknown): string[] {
    if (typeof value !== 'string') {
      return [];
    }

    return value
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  private readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value : null;
  }

  private readStringOrNumber(value: unknown): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }

    return this.readString(value);
  }

  private readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private readNestedString(
    source: Record<string, unknown>,
    path: string[],
  ): string | null {
    let current: unknown = source;

    for (const segment of path) {
      if (typeof current !== 'object' || current === null || !(segment in current)) {
        return null;
      }

      current = (current as Record<string, unknown>)[segment];
    }

    return this.readString(current);
  }
}
