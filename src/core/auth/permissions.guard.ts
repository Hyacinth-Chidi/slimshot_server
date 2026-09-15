import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AdminRole } from '../../generated/prisma/enums';
import { Permission, PERMISSION_KEY, roleHas } from './permissions';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission | undefined>(
      PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Fail-open BY DESIGN: a route with no @RequirePermission is reachable by any
    // authenticated caller. That is correct for auth endpoints and public reads. It is
    // NOT a safe default for admin routes — admin-routes.spec.ts enumerates those and
    // fails the build if a handler forgets its decorator, which is where that class of
    // mistake gets caught.
    if (!required) return true;

    const user = context
      .switchToHttp()
      .getRequest<{ user?: { role: AdminRole } }>().user;

    if (!user) throw new ForbiddenException('Not authenticated.');

    if (!roleHas(user.role, required)) {
      throw new ForbiddenException(`Missing required permission: ${required}`);
    }

    return true;
  }
}
