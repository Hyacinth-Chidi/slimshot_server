import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AccountsModule } from '../accounts/accounts.module';
import { CreditsModule } from '../credits/credits.module';
import { ProvidersModule } from '../providers/providers.module';
import { VoicesModule } from '../voices/voices.module';
import { SpeechSweeper } from './speech-sweeper';
import { QUEUE_SPEECH } from './speech.constants';
import { SpeechController } from './speech.controller';
import { SpeechService } from './speech.service';
import { SpeechWorker } from './speech.worker';

/** Text to speech: voices from the app's texts, charged in credits, kept on disk for TTS_KEEP_MINUTES. */
@Module({
  imports: [BullModule.registerQueue({ name: QUEUE_SPEECH }), AccountsModule, CreditsModule, ProvidersModule, VoicesModule],
  controllers: [SpeechController],
  providers: [SpeechService, SpeechWorker, SpeechSweeper],
})
export class SpeechModule {}
