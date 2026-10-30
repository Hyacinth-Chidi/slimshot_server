import type { PushBatchResult, PushPayload, PushSender } from './push.constants';
import { PushService } from './push.service';

interface Device {
  id: string;
  userId: string | null;
  pushToken: string | null;
  pushTokenAt: Date | null;
}
interface Message {
  id: string;
  title: string;
  body: string;
  audience: string;
  userId: string | null;
  status: string;
  targetCount: number;
  sentCount: number;
  failedCount: number;
  error: string | null;
  sentById: string;
  createdAt: Date;
  finishedAt: Date | null;
}

type Where = { pushToken?: { not: null } | { in: string[] } | string; userId?: string; id?: { gt?: string; not?: string } };

function matches(d: Device, where: Where): boolean {
  if (where.userId !== undefined && d.userId !== where.userId) return false;
  if (where.id?.gt !== undefined && !(d.id > where.id.gt)) return false;
  if (where.id?.not !== undefined && d.id === where.id.not) return false;
  const t = where.pushToken;
  if (t === undefined) return true;
  if (typeof t === 'string') return d.pushToken === t;
  if ('in' in t) return d.pushToken !== null && t.in.includes(d.pushToken);
  return d.pushToken !== null;
}

/** The slice of Prisma PushService uses, in memory. */
function fakeDb(devices: Device[], users: Array<{ id: string; email: string | null; username: string | null }> = []) {
  const messages: Message[] = [];
  const db = {
    devices,
    messages,
    device: {
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Device> }) => {
        const d = devices.find((x) => x.id === where.id)!;
        Object.assign(d, data);
        return d;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Where; data: Partial<Device> }) => {
        const hit = devices.filter((d) => matches(d, where));
        hit.forEach((d) => Object.assign(d, data));
        return { count: hit.length };
      }),
      count: jest.fn(async ({ where }: { where: Where }) => devices.filter((d) => matches(d, where)).length),
      findMany: jest.fn(async ({ where, take }: { where: Where; take: number }) =>
        devices
          .filter((d) => matches(d, where))
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, take)
          .map((d) => ({ id: d.id, pushToken: d.pushToken })),
      ),
    },
    user: {
      findFirst: jest.fn(async ({ where }: { where: { OR: Array<Record<string, string>> } }) =>
        users.find((u) => where.OR.some((c) => Object.entries(c).every(([k, v]) => (u as Record<string, unknown>)[k] === v))) ??
        null,
      ),
    },
    pushMessage: {
      create: jest.fn(async ({ data }: { data: Partial<Message> }) => {
        const m: Message = {
          id: `msg-${messages.length + 1}`,
          status: 'sending',
          targetCount: 0,
          sentCount: 0,
          failedCount: 0,
          error: null,
          userId: null,
          createdAt: new Date(),
          finishedAt: null,
          ...data,
        } as Message;
        messages.push(m);
        return m;
      }),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => messages.find((m) => m.id === where.id) ?? null),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Message> }) => {
        const m = messages.find((x) => x.id === where.id)!;
        Object.assign(m, data);
        return m;
      }),
      findMany: jest.fn(async () => [...messages].reverse()),
    },
    $transaction: jest.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
  };
  return db;
}

const device = (id: string, pushToken: string | null, userId: string | null = null): Device => ({
  id,
  userId,
  pushToken,
  pushTokenAt: pushToken ? new Date() : null,
});

function build(opts: { devices?: Device[]; configured?: boolean; sender?: PushSender } = {}) {
  const db = fakeDb(opts.devices ?? [], [{ id: 'u1', email: 'amaka@x.com', username: 'amaka_edits' }]);
  const sent: Array<{ tokens: string[]; payload: PushPayload }> = [];
  const sender: PushSender = opts.sender ?? {
    send: jest.fn(async (tokens: string[], payload: PushPayload): Promise<PushBatchResult> => {
      sent.push({ tokens, payload });
      return { sent: tokens.length, failed: 0, deadTokens: [] };
    }),
  };
  const queue = { add: jest.fn(async () => ({})) };
  const audit = { record: jest.fn(async () => undefined) };
  const devicesService = {
    authenticate: jest.fn(async (token: string) => (token.startsWith('install-') ? { id: token.slice(8) } : null)),
  };
  const svc = new PushService(
    db as never,
    audit as never,
    queue as never,
    opts.configured === false ? null : sender,
    devicesService as never,
  );
  return { svc, db, queue, audit, sent, sender };
}

describe('PushService.setToken', () => {
  it('stores an install’s token, moving it off any other install', async () => {
    const { svc, db } = build({ devices: [device('d1', null), device('d2', 'tok-A')] });

    expect(await svc.setToken('install-d1', 'tok-A')).toEqual({ registered: true });

    expect(db.devices.find((d) => d.id === 'd1')?.pushToken).toBe('tok-A');
    expect(db.devices.find((d) => d.id === 'd2')?.pushToken).toBeNull();
  });

  it('clears it when the app turns notifications off', async () => {
    const { svc, db } = build({ devices: [device('d1', 'tok-A')] });
    expect(await svc.setToken('install-d1', null)).toEqual({ registered: false });
    expect(db.devices[0].pushToken).toBeNull();
  });

  it('refuses an install it does not know', async () => {
    const { svc } = build({ devices: [] });
    await expect(svc.setToken('nope', 'tok-A')).rejects.toMatchObject({
      status: 422,
      response: { code: 'DEVICE_NOT_REGISTERED' },
    });
  });
});

describe('PushService.send', () => {
  const ADMIN = { id: 'admin-1' };

  it('queues a message to everyone, recording how many installs it is for, and audits it', async () => {
    const { svc, db, queue, audit } = build({ devices: [device('d1', 'tok-A'), device('d2', 'tok-B'), device('d3', null)] });

    const { id } = await svc.send({ title: 'New sounds', body: 'Ten new sounds are in.' }, ADMIN);

    expect(db.messages[0]).toMatchObject({ id, audience: 'all', userId: null, targetCount: 2, status: 'sending', sentById: 'admin-1' });
    expect(queue.add).toHaveBeenCalledWith('send', { messageId: id }, expect.objectContaining({ removeOnComplete: true }));
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'push.sent', actorId: 'admin-1', entityType: 'PushMessage', entityId: id }),
    );
  });

  it.each(['u1', 'amaka@x.com', 'amaka_edits'])('finds one user by id, email or username (%s)', async (who) => {
    const { svc, db } = build({ devices: [device('d1', 'tok-A', 'u1'), device('d2', 'tok-B', 'u2')] });
    await svc.send({ title: 'Hi', body: 'Just for you', user: who }, ADMIN);
    expect(db.messages[0]).toMatchObject({ audience: 'user', userId: 'u1', targetCount: 1 });
  });

  it('says so when no user matches', async () => {
    const { svc, queue } = build({ devices: [device('d1', 'tok-A', 'u1')] });
    await expect(svc.send({ title: 'Hi', body: 'x', user: 'ghost@x.com' }, ADMIN)).rejects.toMatchObject({
      status: 404,
      response: { code: 'NOT_FOUND' },
    });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('refuses when nobody would receive it', async () => {
    const { svc, queue } = build({ devices: [device('d1', null, 'u1')] });
    await expect(svc.send({ title: 'Hi', body: 'x' }, ADMIN)).rejects.toMatchObject({
      status: 422,
      response: { code: 'PUSH_NO_RECIPIENTS', message: 'No install has notifications turned on yet.' },
    });
    await expect(svc.send({ title: 'Hi', body: 'x', user: 'u1' }, ADMIN)).rejects.toMatchObject({
      status: 422,
      response: { code: 'PUSH_NO_RECIPIENTS', message: 'That user has no install with notifications turned on.' },
    });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('refuses while Firebase is not set up', async () => {
    const { svc } = build({ configured: false, devices: [device('d1', 'tok-A')] });
    await expect(svc.send({ title: 'Hi', body: 'x' }, ADMIN)).rejects.toMatchObject({
      status: 503,
      response: { code: 'PUSH_NOT_CONFIGURED' },
    });
  });
});

describe('PushService.deliver', () => {
  it('sends to every install in batches of 500, counts the results and drops dead tokens', async () => {
    const devices = Array.from({ length: 1201 }, (_, i) => device(`d${String(i).padStart(4, '0')}`, `tok-${i}`));
    const sender: PushSender = {
      send: jest.fn(async (tokens: string[]) => ({
        sent: tokens.length - 1,
        failed: 1,
        deadTokens: [tokens[0]],
      })),
    };
    const { svc, db } = build({ devices, sender });
    const { id } = await svc.send({ title: 'New sounds', body: 'In now' }, { id: 'admin-1' });

    await svc.deliver(id);

    expect((sender.send as jest.Mock).mock.calls.map(([tokens]) => tokens.length)).toEqual([500, 500, 201]);
    expect((sender.send as jest.Mock).mock.calls[0][1]).toEqual({ title: 'New sounds', body: 'In now', messageId: id });
    expect(db.messages[0]).toMatchObject({ status: 'sent', sentCount: 1198, failedCount: 3, error: null });
    expect(db.messages[0].finishedAt).toBeInstanceOf(Date);
    expect(db.devices.filter((d) => d.pushToken === null)).toHaveLength(3);
  });

  it('sends only to that user’s installs', async () => {
    const { svc, sent } = build({ devices: [device('d1', 'tok-A', 'u1'), device('d2', 'tok-B', 'u2'), device('d3', 'tok-C', 'u1')] });
    const { id } = await svc.send({ title: 'Hi', body: 'x', user: 'u1' }, { id: 'admin-1' });
    await svc.deliver(id);
    expect(sent.flatMap((s) => s.tokens).sort()).toEqual(['tok-A', 'tok-C']);
  });

  it('records a failure, and what was sent before it', async () => {
    const devices = Array.from({ length: 600 }, (_, i) => device(`d${String(i).padStart(4, '0')}`, `tok-${i}`));
    const sender: PushSender = {
      send: jest
        .fn()
        .mockResolvedValueOnce({ sent: 500, failed: 0, deadTokens: [] })
        .mockRejectedValueOnce(new Error('Firebase rejected the credentials')),
    };
    const { svc, db } = build({ devices, sender });
    const { id } = await svc.send({ title: 'Hi', body: 'x' }, { id: 'admin-1' });

    await expect(svc.deliver(id)).rejects.toThrow('Firebase rejected the credentials');

    expect(db.messages[0]).toMatchObject({ status: 'failed', sentCount: 500, error: 'Firebase rejected the credentials' });
  });

  it('does nothing for a message already finished', async () => {
    const { svc, db, sent } = build({ devices: [device('d1', 'tok-A')] });
    const { id } = await svc.send({ title: 'Hi', body: 'x' }, { id: 'admin-1' });
    db.messages[0].status = 'sent';
    await svc.deliver(id);
    expect(sent).toHaveLength(0);
  });
});

describe('PushService.overview', () => {
  it('says whether push is set up, how many installs have it on, and the latest messages', async () => {
    const { svc } = build({ devices: [device('d1', 'tok-A'), device('d2', null)] });
    await svc.send({ title: 'Hi', body: 'x' }, { id: 'admin-1' });
    const overview = await svc.overview();
    expect(overview).toMatchObject({ configured: true, devices: 1 });
    expect(overview.messages).toHaveLength(1);
    expect(overview.messages[0]).toMatchObject({ title: 'Hi', audience: 'all', status: 'sending', targetCount: 1 });
  });
});
