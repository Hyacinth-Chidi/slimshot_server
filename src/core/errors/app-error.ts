import { HttpException } from '@nestjs/common';

import { ErrorCode } from './error-codes';

/**
 * An HTTP error with a precise code. AllExceptionsFilter keeps the code and
 * passes `details` through, so the app can act on them (e.g. required/balance).
 */
export function appError(
  status: number,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): HttpException {
  return new HttpException({ code, message, ...(details ? { details } : {}) }, status);
}
