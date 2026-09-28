import { ExecutionContext, UnauthorizedException } from '@nestjs/common';

import { DeviceAuthGuard } from './device-auth.guard';

function contextWith(headers: Record<string, string>) {
  const req: { headers: Record<string, string>; device?: unknown } = { headers };
  const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
  return { ctx, req };
}

describe('DeviceAuthGuard', () => {
  const devices = { authenticate: jest.fn(async (t: string) => (t === 'good' ? { id: 'dev-1' } : null)) };
  const guard = new DeviceAuthGuard(devices as never);

  it.each<Record<string, string>>([{}, { authorization: 'Basic good' }, { authorization: 'Bearer' }])(
    'rejects %j with 401',
    async (headers) => {
      await expect(guard.canActivate(contextWith(headers).ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    },
  );

  it('rejects an unknown token with 401', async () => {
    await expect(guard.canActivate(contextWith({ authorization: 'Bearer bad' }).ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('attaches the device for a known token', async () => {
    const { ctx, req } = contextWith({ authorization: 'Bearer good' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.device).toEqual({ id: 'dev-1' });
  });
});
