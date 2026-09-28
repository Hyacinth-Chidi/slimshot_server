import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { CurrentDevice } from '../devices/current-device.decorator';
import { DeviceAuthGuard } from '../devices/device-auth.guard';
import type { AuthenticatedDevice } from '../devices/devices.service';
import { IDEMPOTENCY_KEY } from './captions.constants';
import { CaptionsService, type UploadedAudio } from './captions.service';
import { StartCaptionDto } from './dto/start-caption.dto';

// The guard runs before the file interceptor, so an unauthenticated upload is
// refused without its body ever being read.
@Controller('api/app/v1/captions')
@UseGuards(DeviceAuthGuard)
export class CaptionsController {
  constructor(private readonly captions: CaptionsService) {}

  @Post()
  @HttpCode(202)
  @UseInterceptors(FileInterceptor('audio'))
  async start(
    @CurrentDevice() device: AuthenticatedDevice,
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
    if (!audio.mimetype.startsWith('audio/')) {
      throw new UnsupportedMediaTypeException(
        `The audio part must have an audio/* content type; got ${audio.mimetype}.`,
      );
    }

    return {
      success: true as const,
      data: await this.captions.start(device, audio, dto.language, idempotencyKey),
    };
  }

  @Get(':jobId')
  async status(@CurrentDevice() device: AuthenticatedDevice, @Param('jobId') jobId: string) {
    return { success: true as const, data: await this.captions.status(device, jobId) };
  }
}
