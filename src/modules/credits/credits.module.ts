import { Module } from '@nestjs/common';

import { AccountsModule } from '../accounts/accounts.module';
import { CreditSettingsModule } from './credit-settings.module';
import { CreditsController } from './credits.controller';
import { CreditsService } from './credits.service';
import { LedgerModule } from './ledger.module';
import { PricingService } from './pricing.service';
import { ReconciliationService } from './reconciliation.service';

@Module({
  imports: [LedgerModule, CreditSettingsModule, AccountsModule],
  controllers: [CreditsController],
  providers: [PricingService, CreditsService, ReconciliationService],
  exports: [PricingService, CreditsService, ReconciliationService, LedgerModule],
})
export class CreditsModule {}
