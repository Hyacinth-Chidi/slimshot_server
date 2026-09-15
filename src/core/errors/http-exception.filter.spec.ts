import { ArgumentsHost, BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
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

  it('reports an unmapped 4xx with a neutral code, not a validation failure', () => {
    const { host, json, status } = hostFor();
    filter.catch(new HttpException('Payment required', 402), host);
    expect(status).toHaveBeenCalledWith(402);
    expect(json.mock.calls[0][0].error.code).toBe(ErrorCode.REQUEST_FAILED);
  });
});
