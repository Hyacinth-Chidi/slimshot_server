import { Module } from '@nestjs/common';

import { FeatureRefunds } from './feature-refunds';
import { LedgerService } from './ledger.service';

@Module({ providers: [LedgerService, FeatureRefunds], exports: [LedgerService, FeatureRefunds] })
export class LedgerModule {}
