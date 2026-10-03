import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { OAuth2Client } from 'google-auth-library';

import { emailConfig, type EmailConfig } from '../../config';
import { CreditSettingsModule } from '../credits/credit-settings.module';
import { LedgerModule } from '../credits/ledger.module';
import { DevicesModule } from '../devices/devices.module';
import { AccountDeletionController } from './account-deletion.controller';
import { AccountDeletionService } from './account-deletion.service';
import { AccountsService } from './accounts.service';
import { AppAuthController } from './app-auth.controller';
import { ClaimService } from './claim.service';
import { DeletionPageController } from './deletion-page.controller';
import { createEmailSender, EMAIL_SENDER } from './email-sender';
import { GOOGLE_OAUTH, GoogleVerifier } from './google-verifier';
import { MeController } from './me.controller';
import { MeService } from './me.service';
import { OtpService } from './otp.service';
import { UserAuthGuard } from './user-auth.guard';
import { UserTokensService } from './user-tokens.service';
import { UsernameService } from './username.service';

@Module({
  imports: [JwtModule.register({}), DevicesModule, CreditSettingsModule, LedgerModule],
  controllers: [AppAuthController, MeController, AccountDeletionController, DeletionPageController],
  providers: [
    AccountsService,
    MeService,
    OtpService,
    GoogleVerifier,
    UserTokensService,
    UserAuthGuard,
    UsernameService,
    ClaimService,
    AccountDeletionService,
    { provide: GOOGLE_OAUTH, useFactory: () => new OAuth2Client() },
    { provide: EMAIL_SENDER, inject: [emailConfig.KEY], useFactory: (cfg: EmailConfig) => createEmailSender(cfg) },
  ],
  exports: [UserTokensService, UserAuthGuard, MeService, OtpService, AccountDeletionService],
})
export class AccountsModule {}
