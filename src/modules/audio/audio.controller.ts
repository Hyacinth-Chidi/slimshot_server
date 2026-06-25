import {
  CacheInterceptor,
  CacheTTL,
} from '@nestjs/cache-manager';
import {
  Body,
  BadRequestException,
  Controller,
  Get,
  Header,
  Post,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';

import { SearchAudioDto } from './dto/search-audio.dto';
import { UploadAudioDto } from './dto/upload-audio.dto';
import { UploadedAudioFile } from './interfaces/uploaded-audio-file.interface';
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
  getUploadTemplate(@Req() request: Request) {
    const baseUrl = `${request.protocol}://${request.get('host')}`;
    return this.audioService.getUploadPage(baseUrl);
  }

  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: 50 * 1024 * 1024,
      },
      fileFilter: (_request, file, callback) => {
        if (file.mimetype.startsWith('audio/')) {
          callback(null, true);
          return;
        }

        callback(
          new BadRequestException('Only audio files are allowed.'),
          false,
        );
      },
    }),
  )
  uploadAudio(
    @UploadedFile() file: UploadedAudioFile | undefined,
    @Body() payload: UploadAudioDto,
  ) {
    return this.audioService.upload(file, payload);
  }
}
