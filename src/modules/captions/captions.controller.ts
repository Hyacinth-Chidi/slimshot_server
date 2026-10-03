import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  UnprocessableEntityException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { CurrentAppUser } from '../accounts/current-app-user.decorator';
import { type AuthenticatedAppUser, UserAuthGuard } from '../accounts/user-auth.guard';
import { IDEMPOTENCY_KEY } from './captions.constants';
import { CaptionsService, type UploadedAudio } from './captions.service';
import { StartCaptionDto } from './dto/start-caption.dto';

// The guard runs before the file interceptor, so an upload without a signed-in
// user is refused before its body is read.
@Controller('api/app/v1/captions')
@UseGuards(UserAuthGuard)
export class CaptionsController {
  constructor(private readonly captions: CaptionsService) {}

  @Post()
  @HttpCode(202)
  @UseInterceptors(FileInterceptor('audio'))
  async start(
    @CurrentAppUser() user: AuthenticatedAppUser,
    @UploadedFile() audio: UploadedAudio | undefined,
    @Body() dto: StartCaptionDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new UnprocessableEntityException(
        'Send an Idempotency-Key header of 8–64 letters, digits, "-" or "_" (a UUID works).',
      );
    }
    if (!audio) {
      throw new UnprocessableEntityException('Attach the audio as a multipart file field named "audio".');
    }
    return {
      success: true as const,
      data: await this.captions.start(user, audio, dto.language, idempotencyKey),
    };
  }

  @Get(':jobId')
  async status(@CurrentAppUser() user: AuthenticatedAppUser, @Param('jobId') jobId: string) {
    return { success: true as const, data: await this.captions.status(user, jobId) };
  }
}
