import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginAttemptService } from './login-attempt.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    LoginAttemptService,
    JwtAuthGuard,
    PermissionsGuard,
  ],
  exports: [
    TokenService,
    LoginAttemptService,
    PasswordService,
    JwtAuthGuard,
    PermissionsGuard,
  ],
})
export class AuthModule {}
