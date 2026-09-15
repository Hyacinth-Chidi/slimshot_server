import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AdminRole } from '../../generated/prisma/enums';
import { PermissionsGuard } from './permissions.guard';

function ctxFor(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

describe('PermissionsGuard', () => {
  function guardRequiring(permission: string | undefined) {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(permission) };
    return new PermissionsGuard(reflector as unknown as Reflector);
  }

  it('allows a route with no declared permission', () => {
    expect(guardRequiring(undefined).canActivate(ctxFor({ role: AdminRole.viewer })))
      .toBe(true);
  });

  it('allows a role that holds the permission', () => {
    expect(
      guardRequiring('asset.publish').canActivate(ctxFor({ role: AdminRole.editor })),
    ).toBe(true);
  });

  it('rejects a role that lacks the permission', () => {
    expect(() =>
      guardRequiring('asset.delete').canActivate(ctxFor({ role: AdminRole.editor })),
    ).toThrow(ForbiddenException);
  });

  it('rejects when no user is attached to the request', () => {
    expect(() =>
      guardRequiring('asset.read').canActivate(ctxFor(undefined)),
    ).toThrow(ForbiddenException);
  });

  it('names the missing permission in the error', () => {
    expect(() =>
      guardRequiring('settings.write').canActivate(ctxFor({ role: AdminRole.admin })),
    ).toThrow(/settings\.write/);
  });
});
