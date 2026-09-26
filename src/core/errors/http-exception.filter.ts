import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { ErrorCode } from './error-codes';

interface PrismaLikeError {
  code?: string;
  meta?: Record<string, unknown>;
}

/**
 * Prisma codes for "the database could not be reached", plus the Node network
 * codes a driver adapter surfaces for the same thing (EAI_AGAIN is a DNS
 * lookup that failed; the others are refused, reset or timed-out connections).
 */
const UNREACHABLE_CODES = new Set([
  'P1001',
  'P1002',
  'P1008',
  'P1017',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
]);

function isDatabaseUnreachable(exception: unknown): boolean {
  let current: unknown = exception;
  // Walk a short cause chain: adapters wrap the network error in their own.
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const e = current as { code?: unknown; errorCode?: unknown; cause?: unknown };
    if (typeof e.code === 'string' && UNREACHABLE_CODES.has(e.code)) return true;
    if (typeof e.errorCode === 'string' && UNREACHABLE_CODES.has(e.errorCode)) return true;
    current = e.cause;
  }
  return false;
}

function firstLine(exception: unknown): string {
  const text = exception instanceof Error ? exception.message : String(exception);
  return text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<{ status: (c: number) => { json: (b: unknown) => void } }>();
    const req = http.getRequest<{ id?: string; url?: string; method?: string }>();
    // Every error response carries an id that also appears in the log line, so
    // a report from the dashboard can be matched to what the server saw.
    const traceId = req?.id ?? randomUUID();

    const { status, code, message, details } = this.classify(exception);
    const where = `${req?.method ?? '?'} ${req?.url ?? '?'} -> ${status} [${traceId}]`;

    if (code === ErrorCode.DATABASE_UNAVAILABLE) {
      // An outage is not a bug: one line, no stack, so it doesn't drown the log.
      this.logger.error(`${where} database unreachable: ${firstLine(exception)}`);
    } else if (status >= 500) {
      this.logger.error(where, exception instanceof Error ? exception.stack : String(exception));
    }

    res.status(status).json({
      success: false,
      error: { code, message, ...(details ? { details } : {}), traceId },
    });
  }

  private classify(exception: unknown): {
    status: number;
    code: ErrorCode;
    message: string;
    details?: unknown;
  } {
    const prisma = exception as PrismaLikeError;

    if (isDatabaseUnreachable(exception)) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: ErrorCode.DATABASE_UNAVAILABLE,
        message: 'The database is unavailable right now. Try again shortly.',
      };
    }

    if (prisma?.code === 'P2002') {
      return {
        status: HttpStatus.CONFLICT,
        code: ErrorCode.CONFLICT,
        message: 'A record with these values already exists.',
        details: prisma.meta?.target,
      };
    }

    if (prisma?.code === 'P2025') {
      return {
        status: HttpStatus.NOT_FOUND,
        code: ErrorCode.NOT_FOUND,
        message: 'The requested record does not exist.',
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const raw = typeof body === 'object' && body !== null
        ? (body as { message?: string | string[] }).message
        : undefined;

      // class-validator failures arrive as BadRequest with a string[] message.
      if (status === HttpStatus.BAD_REQUEST && Array.isArray(raw)) {
        return {
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          code: ErrorCode.VALIDATION_FAILED,
          message: 'Request validation failed.',
          details: raw,
        };
      }

      return {
        status,
        code: this.codeForStatus(status),
        message: Array.isArray(raw) ? raw.join(', ') : raw ?? exception.message,
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL,
      message: 'Internal server error',
    };
  }

  private codeForStatus(status: number): ErrorCode {
    switch (status) {
      case HttpStatus.UNAUTHORIZED:
        return ErrorCode.UNAUTHENTICATED;
      case HttpStatus.FORBIDDEN:
        return ErrorCode.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ErrorCode.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ErrorCode.CONFLICT;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ErrorCode.RATE_LIMITED;
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return ErrorCode.VALIDATION_FAILED;
      default:
        return status >= 500 ? ErrorCode.INTERNAL : ErrorCode.REQUEST_FAILED;
    }
  }
}
