import { ExecutionContext, UnauthorizedException } from '@nestjs/common';

import { AdminRole } from '../../generated/prisma/enums';
import { JwtAuthGuard } from './jwt-auth.guard';

const CLAIMS = {
  sub: 'admin-1',
  email: 'a@example.com',
  role: AdminRole.admin,
};

function activeRow(overrides: Record<string, unknown> = {}) {
  return { id: 'admin-1', isActive: true, role: AdminRole.admin, ...overrides };
}

function build(row: Record<string, unknown> | null, verifyThrows = false) {
  const tokens = {
    verifyAccessToken: jest.fn(async () => {
      if (verifyThrows) throw new UnauthorizedException('bad token');
      return CLAIMS;
    }),
  };
  const prisma = {
    adminUser: { findFirst: jest.fn(async () => row) },
  };
  return {
    guard: new JwtAuthGuard(tokens as never, prisma as never),
    tokens,
    prisma,
  };
}

function ctxFor(
  header: string | undefined,
): { context: ExecutionContext; req: { user?: { role: AdminRole } } } {
  const req: { headers: Record<string, string | undefined>; user?: { role: AdminRole } } =
    { headers: { authorization: header } };
  return {
    context: {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext,
    req,
  };
}

describe('JwtAuthGuard', () => {
  it('rejects a request with no Authorization header', async () => {
    const { guard } = build(activeRow());
    const { context } = ctxFor(undefined);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a non-Bearer scheme', async () => {
    const { guard } = build(activeRow());
    const { context } = ctxFor('Basic abc123');
    await expect(guard.canActivate(context)).rejects.toThrow(/bearer/i);
  });

  it('rejects when the token itself does not verify', async () => {
    const { guard } = build(activeRow(), true);
    const { context } = ctxFor('Bearer tampered');
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('allows an active admin and attaches the claims', async () => {
    const { guard } = build(activeRow());
    const { context, req } = ctxFor('Bearer good');

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.user).toMatchObject({ sub: 'admin-1', role: AdminRole.admin });
  });

  // The next three are the reason this guard touches the database at all. A pure
  // signature check would let a revoked admin keep full authority until their
  // access token expired, with no way to cut it short — refresh-token revocation
  // does not help, because the access token never touches one.

  it('blocks a deactivated admin immediately, not when the token expires', async () => {
    const { guard } = build(activeRow({ isActive: false }));
    const { context } = ctxFor('Bearer still-valid-signature');

    await expect(guard.canActivate(context)).rejects.toThrow(/no longer active/);
  });

  it('blocks a soft-deleted admin immediately', async () => {
    // findFirst filters on deletedAt: null, so a deleted row returns nothing.
    const { guard } = build(null);
    const { context } = ctxFor('Bearer still-valid-signature');

    await expect(guard.canActivate(context)).rejects.toThrow(/no longer active/);
  });

  it('honours a role demotion from the row over the role in the token', async () => {
    const { guard } = build(activeRow({ role: AdminRole.viewer }));
    const { context, req } = ctxFor('Bearer minted-while-admin');

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.user?.role).toBe(AdminRole.viewer);
  });

  it('excludes soft-deleted accounts in the lookup it performs', async () => {
    const { guard, prisma } = build(activeRow());
    const { context } = ctxFor('Bearer good');
    await guard.canActivate(context);

    expect(prisma.adminUser.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'admin-1', deletedAt: null }),
      }),
    );
  });
});
