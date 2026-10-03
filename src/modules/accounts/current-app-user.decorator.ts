import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import type { AuthenticatedAppUser } from './user-auth.guard';

export const CurrentAppUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedAppUser =>
    context.switchToHttp().getRequest<{ appUser: AuthenticatedAppUser }>().appUser,
);
