import { Module } from '@nestjs/common';

import { CreditSettingsService } from './credit-settings.service';

@Module({ providers: [CreditSettingsService], exports: [CreditSettingsService] })
export class CreditSettingsModule {}
