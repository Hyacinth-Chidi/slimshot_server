import {
  CacheInterceptor,
  CacheTTL,
} from '@nestjs/cache-manager';
import { Controller, Get, Query, UseInterceptors } from '@nestjs/common';

import { SearchAudioDto } from './dto/search-audio.dto';
import { AudioService } from './audio.service';

@Controller('api/v1/audio')
@UseInterceptors(CacheInterceptor)
export class AudioController {
  constructor(private readonly audioService: AudioService) {}

  @Get('search')
  @CacheTTL(60 * 60 * 24)
  async searchAudio(@Query() query: SearchAudioDto) {
    return this.audioService.search(query);
  }

  @Get('categories')
  getCategories() {
    return this.audioService.getCategories();
  }
}
