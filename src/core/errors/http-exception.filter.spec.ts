import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AllExceptionsFilter } from './http-exception.filter';
import { ErrorCode } from './error-codes';

function hostFor(): { host: ArgumentsHost; json: jest.Mock; status: jest.Mock } {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ id: 'trace-123', url: '/x', method: 'GET' }),
    }),
  } as unknown as ArgumentsHost;
  return { host, json, status };
}

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  it('maps Prisma P2002 to 409 CONFLICT', () => {
    const { host, json, status } = hostFor();
    filter.catch({ code: 'P2002', meta: { target: ['slug'] } }, host);
    expect(status).toHaveBeenCalledWith(409);
    expect(json.mock.calls[0][0]).toMatchObject({
      success: false,
      error: { code: ErrorCode.CONFLICT, traceId: 'trace-123' },
    });
  });

  it('maps Prisma P2025 to 404 NOT_FOUND', () => {
    const { host, json, status } = hostFor();
    filter.catch({ code: 'P2025' }, host);
    expect(status).toHaveBeenCalledWith(404);
    expect(json.mock.calls[0][0].error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('preserves an explicit HttpException status', () => {
    const { host, json, status } = hostFor();
    filter.catch(new NotFoundException('gone'), host);
    expect(status).toHaveBeenCalledWith(404);
    expect(json.mock.calls[0][0].error.message).toBe('gone');
  });

  it('maps validation BadRequest to 422 VALIDATION_FAILED', () => {
    const { host, json, status } = hostFor();
    filter.catch(
      new BadRequestException({ message: ['title must be a string'] }),
      host,
    );
    expect(status).toHaveBeenCalledWith(422);
    expect(json.mock.calls[0][0].error.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(json.mock.calls[0][0].error.details).toEqual(['title must be a string']);
  });

  it('never leaks an unknown error message to the client', () => {
    const { host, json, status } = hostFor();
    filter.catch(new Error('connect ECONNREFUSED 10.0.0.5:5432'), host);
    expect(status).toHaveBeenCalledWith(500);
    expect(json.mock.calls[0][0].error.message).toBe('Internal server error');
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain('10.0.0.5');
  });

  describe('database unreachable', () => {
    const cases: Array<[string, unknown]> = [
      [
        'Prisma P1001',
        Object.assign(
          new Error("Can't reach database server at db.internal-host.example"),
          { code: 'P1001' },
        ),
      ],
      [
        'PrismaClientInitializationError',
        Object.assign(new Error('Init failed at db.internal-host.example'), {
          name: 'PrismaClientInitializationError',
          errorCode: 'P1001',
        }),
      ],
      [
        'a DNS failure in the driver',
        Object.assign(new Error('getaddrinfo EAI_AGAIN db.internal-host.example'), {
          code: 'EAI_AGAIN',
        }),
      ],
      [
        'a network error wrapped as a cause',
        Object.assign(new Error('Query failed'), {
          cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        }),
      ],
    ];

    it.each(cases)('maps %s to 503 DATABASE_UNAVAILABLE without leaking the host', (_, err) => {
      const { host, json, status } = hostFor();
      filter.catch(err, host);
      expect(status).toHaveBeenCalledWith(503);
      const body = json.mock.calls[0][0];
      expect(body.error.code).toBe(ErrorCode.DATABASE_UNAVAILABLE);
      expect(body.error.message).toMatch(/database is unavailable/i);
      expect(JSON.stringify(body)).not.toContain('internal-host');
    });

    it('logs one line with the trace id, not a stack trace', () => {
      const { host } = hostFor();
      const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      filter.catch(Object.assign(new Error("Can't reach database server"), { code: 'P1001' }), host);
      expect(log).toHaveBeenCalledTimes(1);
      const args = log.mock.calls[0];
      expect(args).toHaveLength(1);
      expect(String(args[0])).toContain('503');
      expect(String(args[0])).toContain('trace-123');
      expect(String(args[0])).toContain("Can't reach database server");
      log.mockRestore();
    });
  });

  it('generates a trace id when the request has none, and uses it in both the log and the body', () => {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ url: '/x', method: 'POST' }),
      }),
    } as unknown as ArgumentsHost;
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    filter.catch(new Error('boom'), host);

    const traceId = json.mock.calls[0][0].error.traceId as string;
    expect(traceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(String(log.mock.calls[0][0])).toContain(traceId);
    log.mockRestore();
  });

  it('reports an unmapped 4xx with a neutral code, not a validation failure', () => {
    const { host, json, status } = hostFor();
    filter.catch(new HttpException('Payment required', 402), host);
    expect(status).toHaveBeenCalledWith(402);
    expect(json.mock.calls[0][0].error.code).toBe(ErrorCode.REQUEST_FAILED);
  });
});
