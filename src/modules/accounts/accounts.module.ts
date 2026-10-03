import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { OAuth2Client } from 'google-auth-library';

import { emailConfig, type EmailConfig } from '../../config';
import { CreditSettingsModule } from '../credits/credit-settings.module';
import { DevicesModule } from '../devices/devices.module';
import { AccountsService } from './accounts.service';
import { AppAuthController } from './app-auth.controller';
import { createEmailSender, EMAIL_SENDER } from './email-sender';
import { GOOGLE_OAUTH, GoogleVerifier } from './google-verifier';
import { MeService } from './me.service';
import { OtpService } from './otp.service';
import { UserAuthGuard } from './user-auth.guard';
import { UserTokensService } from './user-tokens.service';

@Module({
  imports: [JwtModule.register({}), DevicesModule, CreditSettingsModule],
  controllers: [AppAuthController],
  providers: [
    AccountsService,
    MeService,
    OtpService,
    GoogleVerifier,
    UserTokensService,
    UserAuthGuard,
    { provide: GOOGLE_OAUTH, useFactory: () => new OAuth2Client() },
    { provide: EMAIL_SENDER, inject: [emailConfig.KEY], useFactory: (cfg: EmailConfig) => createEmailSender(cfg) },
  ],
  exports: [UserTokensService, UserAuthGuard, MeService, OtpService],
})
export class AccountsModule {}
