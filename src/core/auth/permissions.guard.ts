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
