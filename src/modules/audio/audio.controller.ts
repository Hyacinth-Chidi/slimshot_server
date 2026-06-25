import {
  CacheInterceptor,
  CacheTTL,
} from '@nestjs/cache-manager';
import {
  Body,
  Controller,
  Get,
  Header,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';

import { CreateAudioUploadSignatureDto } from './dto/create-audio-upload-signature.dto';
import { FinalizeAudioUploadDto } from './dto/finalize-audio-upload.dto';
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

  @Get('upload')
  @Header('Content-Type', 'text/html; charset=utf-8')
  getUploadTemplate() {
    return this.audioService.getUploadPage();
  }

  @Post('upload/sign')
  createUploadSignature(@Body() payload: CreateAudioUploadSignatureDto) {
    return this.audioService.createUploadSignature(payload);
  }

  @Post('upload')
  finalizeUpload(@Body() payload: FinalizeAudioUploadDto) {
    return this.audioService.upload(payload);
  }
}
