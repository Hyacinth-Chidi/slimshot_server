import { Module } from '@nestjs/common';

import { AccountsModule } from '../accounts/accounts.module';
import { CreditSettingsModule } from '../credits/credit-settings.module';
import { CreditsModule } from '../credits/credits.module';
import { AdSessionsService } from './ad-sessions.service';
import { AdmobVerifier } from './admob-verifier';
import { RewardsController } from './rewards.controller';

@Module({
  imports: [AccountsModule, CreditsModule, CreditSettingsModule],
  controllers: [RewardsController],
  providers: [AdmobVerifier, AdSessionsService],
})
export class RewardsModule {}
