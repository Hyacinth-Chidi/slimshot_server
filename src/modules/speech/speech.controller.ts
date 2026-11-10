import { open } from 'node:fs/promises';

import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Post,
  StreamableFile,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';

import { CurrentAppUser } from '../accounts/current-app-user.decorator';
import { type AuthenticatedAppUser, UserAuthGuard } from '../accounts/user-auth.guard';
import { IDEMPOTENCY_KEY } from '../captions/captions.constants';
import { StartSpeechDto } from './dto/start-speech.dto';
import { itemNotFound, SpeechService } from './speech.service';

@Controller('api/app/v1/speech')
@UseGuards(UserAuthGuard)
export class SpeechController {
  constructor(private readonly speech: SpeechService) {}

  @Post()
  @HttpCode(202)
  async start(
    @CurrentAppUser() user: AuthenticatedAppUser,
    @Body() dto: StartSpeechDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new UnprocessableEntityException(
        'Send an Idempotency-Key header of 8–64 letters, digits, "-" or "_" (a UUID works).',
      );
    }
    const request = { voiceId: dto.voiceId, items: dto.items.map(({ id, text }) => ({ id, text })) };
    return { success: true as const, data: await this.speech.start(user, request, idempotencyKey) };
  }

  @Get(':jobId')
  async status(@CurrentAppUser() user: AuthenticatedAppUser, @Param('jobId') jobId: string) {
    return { success: true as const, data: await this.speech.status(user, jobId) };
  }

  @Get(':jobId/items/:itemId')
  @Header('Cache-Control', 'private, no-store')
  async audio(
    @CurrentAppUser() user: AuthenticatedAppUser,
    @Param('jobId') jobId: string,
    @Param('itemId') itemId: string,
  ): Promise<StreamableFile> {
    const path = await this.speech.audioPath(user, jobId, itemId);
    // Opened before the answer starts: a file swept since the check is a 404,
    // never a broken stream (whose error would quote the path).
    const handle = await open(path, 'r').catch(() => {
      throw itemNotFound();
    });
    try {
      const { size } = await handle.stat();
      return new StreamableFile(handle.createReadStream(), { type: 'audio/mpeg', length: size });
    } catch (err) {
      await handle.close();
      throw err;
    }
  }
}
