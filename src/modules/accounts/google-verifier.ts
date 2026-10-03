import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { OAuth2Client, TokenPayload } from 'google-auth-library';

import { appAuthConfig, type AppAuthConfig } from '../../config';
import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { normalizeEmail } from '../../core/identity/email';

export const GOOGLE_OAUTH = Symbol('GOOGLE_OAUTH');

/**
 * Checks a Google ID token from the app's account picker: signed by Google,
 * issued for our Web client ID, not expired, with a verified email.
 */
@Injectable()
export class GoogleVerifier {
  constructor(
    @Inject(appAuthConfig.KEY) private readonly cfg: AppAuthConfig,
    @Inject(GOOGLE_OAUTH) private readonly client: Pick<OAuth2Client, 'verifyIdToken'>,
  ) {}

  async verify(idToken: string): Promise<{ sub: string; email: string }> {
    if (this.cfg.googleClientIds.length === 0) {
      throw appError(HttpStatus.SERVICE_UNAVAILABLE, ErrorCode.SIGN_IN_METHOD_UNAVAILABLE, 'Google sign-in is not set up on the server.');
    }
    let payload: TokenPayload | undefined;
    try {
      payload = (await this.client.verifyIdToken({ idToken, audience: this.cfg.googleClientIds })).getPayload();
    } catch {
      payload = undefined;
    }
    if (!payload?.sub) {
      throw appError(HttpStatus.UNAUTHORIZED, ErrorCode.GOOGLE_TOKEN_INVALID, 'Google sign-in could not be verified. Try again.');
    }
    if (!payload.email || payload.email_verified !== true) {
      throw appError(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.GOOGLE_EMAIL_UNVERIFIED, 'This Google account has no verified email.');
    }
    return { sub: payload.sub, email: normalizeEmail(payload.email) };
  }
}
