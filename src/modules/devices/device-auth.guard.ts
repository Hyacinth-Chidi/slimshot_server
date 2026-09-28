import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

import { AuthenticatedDevice, DevicesService } from './devices.service';

/** App routes only. Admin routes keep JwtAuthGuard; the two never mix. */
@Injectable()
export class DeviceAuthGuard implements CanActivate {
  constructor(private readonly devices: DevicesService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined>; device?: AuthenticatedDevice }>();

    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException('Missing device token.');
    }

    const device = await this.devices.authenticate(token);
    if (!device) {
      throw new UnauthorizedException('Unknown device token. Register the device again.');
    }

    req.device = device;
    return true;
  }
}
