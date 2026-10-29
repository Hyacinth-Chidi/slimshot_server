import { UnprocessableEntityException } from '@nestjs/common';

import { AdminAuditController } from './admin-audit.controller';

interface FindManyArgs {
  take: number;
  orderBy: unknown;
  cursor?: { id: string };
  skip?: number;
  where: Record<string, unknown>;
}

function build(rowCount = 0) {
  const calls: FindManyArgs[] = [];
  const prisma = {
    auditLog: {
      findMany: jest.fn(async (args: FindManyArgs) => {
        calls.push(args);
        return Array.from({ length: Math.min(rowCount, args.take) }, (_, i) => ({
          id: `log-${i}`,
          createdAt: new Date(),
        }));
      }),
    },
  };

  return { ctl: new AdminAuditController(prisma as never), prisma, calls };
}

describe('AdminAuditController.list enrichment', () => {
  it('adds the actor, the entity label and whether it was deleted', async () => {
    const prisma = {
      auditLog: {
        findMany: jest.fn(async () => [
          { id: 'l1', actorId: 'adm1', actorType: 'admin', action: 'asset.publish', entityType: 'Asset', entityId: 'a1', createdAt: new Date() },
          { id: 'l2', actorId: null, actorType: 'system', action: 'credits.refund.failed', entityType: 'User', entityId: 'u1', createdAt: new Date() },
        ]),
      },
      adminUser: { findMany: jest.fn(async () => [{ id: 'adm1', email: 'owner@slimshot.dev', name: 'Owner' }]) },
      asset: { findMany: jest.fn(async () => [{ id: 'a1', title: 'UI Button Click', deletedAt: null }]) },
      user: { findMany: jest.fn(async () => [{ id: 'u1', username: 'amaka_edits', email: null, accountStatus: 'active' }]) },
    };
    const res = await new AdminAuditController(prisma as never).list();

    expect(res.data[0]).toMatchObject({
      action: 'asset.publish',
      actor: { id: 'adm1', email: 'owner@slimshot.dev', name: 'Owner' },
      entityLabel: 'UI Button Click',
      entityDeleted: false,
    });
    // Only admins are looked up; a system entry has no actor.
    expect(res.data[1]).toMatchObject({ actor: null, entityLabel: 'amaka_edits', entityDeleted: false });
  });
});

describe('AdminAuditController.list provider entries', () => {
  // Removing a key or switching a provider off is written with no entityId,
  // and a key added again is a new row: the name must come from the entry.
  it('names the provider from the entry, even when the key row is gone', async () => {
    const prisma = {
      auditLog: {
        findMany: jest.fn(async () => [
          { id: 'l1', actorId: null, actorType: 'system', action: 'provider.key.removed', entityType: 'ProviderCredential', entityId: null, after: { provider: 'deepgram', capability: 'speech_to_text' }, createdAt: new Date() },
          { id: 'l2', actorId: null, actorType: 'system', action: 'provider.key.set', entityType: 'ProviderCredential', entityId: 'old-row', after: { provider: 'elevenlabs', capability: 'speech_to_text' }, createdAt: new Date() },
        ]),
      },
      providerCredential: { findMany: jest.fn(async () => []) },
    };
    const res = await new AdminAuditController(prisma as never).list();

    expect(res.data[0]).toMatchObject({ entityLabel: 'Deepgram', entityDeleted: false });
    expect(res.data[1]).toMatchObject({ entityLabel: 'ElevenLabs', entityDeleted: false });
  });
});

describe('AdminAuditController.list', () => {
  // A cursor is only stable over a total order. `createdAt` alone is not
  // unique - two rows written in the same millisecond, which a burst of audit
  // writes produces routinely, order arbitrarily between queries, so a page
  // boundary landing inside a tie silently skips or repeats rows.
  it('orders by createdAt AND id so the cursor sits on a total order', async () => {
    const { ctl, calls } = build();
    await ctl.list();

    expect(calls[0].orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it('clamps a negative limit to at least one row', async () => {
    const { ctl, calls } = build();
    await ctl.list(undefined, undefined, undefined, undefined, undefined, '-5');

    // Prisma rejects a negative take outright; reaching it at all is a 500
    // where the caller merely sent nonsense.
    expect(calls[0].take).toBeGreaterThanOrEqual(1);
  });

  it('caps the limit at the maximum', async () => {
    const { ctl, calls } = build();
    await ctl.list(undefined, undefined, undefined, undefined, undefined, '5000');

    expect(calls[0].take).toBeLessThanOrEqual(101);
  });

  it('rejects a non-numeric limit rather than silently defaulting', async () => {
    const { ctl } = build();
    await expect(
      ctl.list(undefined, undefined, undefined, undefined, undefined, 'abc'),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('returns no cursor when the last page is exactly full', async () => {
    // Exactly `take` rows exist in total. The old check - rows.length === take
    // - reported a cursor here, and following it yielded an empty page.
    const { ctl } = build(10);
    const out = await ctl.list(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '10',
    );

    expect(out.data).toHaveLength(10);
    expect(out.meta.nextCursor).toBeNull();
  });

  it('returns a cursor and trims the probe row when more rows exist', async () => {
    const { ctl, calls } = build(50);
    const out = await ctl.list(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '10',
    );

    // One extra row is fetched purely to learn whether a next page exists; it
    // must not be served to the caller.
    expect(calls[0].take).toBe(11);
    expect(out.data).toHaveLength(10);
    expect(out.meta.nextCursor).toBe('log-9');
  });
});
