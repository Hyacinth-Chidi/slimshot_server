import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

import { ErrorCode } from './error-codes';

interface PrismaLikeError {
  code?: string;
  meta?: Record<string, unknown>;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<{ status: (c: number) => { json: (b: unknown) => void } }>();
    const req = http.getRequest<{ id?: string; url?: string; method?: string }>();
    const traceId = req?.id ?? 'unknown';

    const { status, code, message, details } = this.classify(exception);

    if (status >= 500) {
      this.logger.error(
        `${req?.method ?? '?'} ${req?.url ?? '?'} -> ${status} [${traceId}]`,
        exception instanceof Error ? exception.stack : String(exception),
      );
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
