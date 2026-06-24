import {
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

import {
  AudioCategory,
  AudioSearchMeta,
  AudioTrack,
} from '../../common/interfaces/audio-track.interface';
import { SearchAudioDto } from './dto/search-audio.dto';
import { PixabayService } from './providers/pixabay.service';

export interface SearchResponse {
  success: true;
  data: AudioTrack[];
  meta: AudioSearchMeta;
}

export interface CategoriesResponse {
  success: true;
  data: AudioCategory[];
}

interface ProviderSearchResult {
  data: AudioTrack[];
  total: number;
  configured: boolean;
  successful: boolean;
  message?: string;
}

@Injectable()
export class AudioService {
  private readonly categories: AudioCategory[] = [
    { id: 'cinematic', name: 'Cinematic', type: 'music' },
    { id: 'ambient', name: 'Ambient', type: 'music' },
    { id: 'corporate', name: 'Corporate', type: 'music' },
    { id: 'lofi', name: 'Lofi', type: 'music' },
    { id: 'transitions', name: 'Transitions', type: 'sfx' },
    { id: 'whoosh', name: 'Whoosh', type: 'sfx' },
    { id: 'impacts', name: 'Impacts', type: 'sfx' },
    { id: 'ui', name: 'UI', type: 'sfx' },
  ];

  constructor(private readonly pixabayService: PixabayService) {}

  async search(query: SearchAudioDto): Promise<SearchResponse> {
    const result: ProviderSearchResult = await this.pixabayService.search(query);

    if (!result.configured) {
      throw new ServiceUnavailableException(
        result.message ?? 'Pixabay is not configured. Add PIXABAY_API_KEY to .env.',
      );
    }

    if (!result.successful) {
      throw new ServiceUnavailableException(
        result.message ?? 'Pixabay is currently unavailable.',
      );
    }

    const normalizedData = result.data
      .sort((left, right) => right.duration_seconds - left.duration_seconds)
      .slice(0, query.limit);

    return {
      success: true,
      data: normalizedData,
      meta: {
        total_results: result.total,
        page: query.page,
        has_more: result.total > query.page * query.limit,
      },
    };
  }

  getCategories(): CategoriesResponse {
    return {
      success: true,
      data: this.categories,
    };
  }
}
