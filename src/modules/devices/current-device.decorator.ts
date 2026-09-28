import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import { AuthenticatedDevice } from './devices.service';

export const CurrentDevice = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedDevice =>
    context.switchToHttp().getRequest<{ device: AuthenticatedDevice }>().device,
);
