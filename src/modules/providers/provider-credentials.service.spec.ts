import { ConflictException, UnprocessableEntityException } from '@nestjs/common';

import { EnvelopeCryptoService } from '../../core/crypto/envelope-crypto.service';
import { ProviderCapability, ProviderKind } from '../../generated/prisma/enums';
import { ProviderCredentialsService } from './provider-credentials.service';

const STT = ProviderCapability.speech_to_text;

interface Row {
  id: string;
  provider: ProviderKind;
  capability: ProviderCapability;
  apiKeyCipher: Uint8Array<ArrayBuffer>;
  keyVersion: number;
  isActive: boolean;
  updatedById: string | null;
  updatedAt: Date;
}

type Where = Record<string, unknown> & {
  provider_capability?: { provider: ProviderKind; capability: ProviderCapability };
};

function matches(row: Row, where: Where = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'provider_capability') {
      const pc = value as NonNullable<Where['provider_capability']>;
      return row.provider === pc.provider && row.capability === pc.capability;
    }
    return (row as unknown as Record<string, unknown>)[key] === value;
  });
}

function build(seed: Array<{ provider: ProviderKind; key: string; isActive?: boolean }> = []) {
  const crypto = new EnvelopeCryptoService('ab'.repeat(32));
  const rows: Row[] = seed.map((s, i) => ({
    id: `cred-${i + 1}`,
    provider: s.provider,
    capability: STT,
    apiKeyCipher: crypto.encrypt(s.key).cipher,
    keyVersion: 1,
    isActive: s.isActive ?? false,
    updatedById: null,
    updatedAt: new Date('2026-09-28T10:00:00Z'),
  }));

  const prisma = {
    providerCredential: {
      findMany: jest.fn(async ({ where }: { where: Where }) => rows.filter((r) => matches(r, where))),
      findUnique: jest.fn(async ({ where }: { where: Where }) => rows.find((r) => matches(r, where)) ?? null),
      findFirst: jest.fn(async ({ where }: { where: Where }) => rows.find((r) => matches(r, where)) ?? null),
      upsert: jest.fn(
        async ({ where, create, update }: { where: Where; create: Partial<Row>; update: Partial<Row> }) => {
          const existing = rows.find((r) => matches(r, where));
          if (existing) {
            Object.assign(existing, update, { updatedAt: new Date() });
            return existing;
          }
          const row = { id: `cred-${rows.length + 1}`, isActive: false, updatedAt: new Date(), ...create } as Row;
          rows.push(row);
          return row;
        },
      ),
      deleteMany: jest.fn(async ({ where }: { where: Where }) => {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i -= 1) if (matches(rows[i], where)) rows.splice(i, 1);
        return { count: before - rows.length };
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Where; data: Partial<Row> }) => {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      }),
      update: jest.fn(async ({ where, data }: { where: Where; data: Partial<Row> }) => {
        const row = rows.find((r) => matches(r, where));
        if (!row) throw Object.assign(new Error('not found'), { code: 'P2025' });
        Object.assign(row, data);
        return row;
      }),
    },
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };

  const adapters = {
    [ProviderKind.deepgram]: { kind: ProviderKind.deepgram, testKey: jest.fn(async () => ({ ok: true, message: 'Key works.' })), transcribe: jest.fn() },
    [ProviderKind.elevenlabs]: { kind: ProviderKind.elevenlabs, testKey: jest.fn(async () => ({ ok: true, message: 'Key works.' })), transcribe: jest.fn() },
  };
  const registry = { speechToTextFor: jest.fn((kind: ProviderKind) => adapters[kind]) };
  const audit = { record: jest.fn(async (_entry: unknown) => undefined) };

  const svc = new ProviderCredentialsService(prisma as never, crypto, registry as never, audit as never);
  return { svc, rows, prisma, audit, adapters, crypto };
}

describe('ProviderCredentialsService.list', () => {
  it('lists every provider, configured or not, and never the key', async () => {
    const { svc } = build([{ provider: ProviderKind.deepgram, key: 'dg-secret-key-1', isActive: true }]);
    const list = await svc.list(STT);

    expect(list).toEqual([
      { provider: 'deepgram', capability: STT, configured: true, active: true, updatedAt: new Date('2026-09-28T10:00:00Z') },
      { provider: 'elevenlabs', capability: STT, configured: false, active: false, updatedAt: null },
    ]);
    expect(JSON.stringify(list)).not.toMatch(/dg-secret-key-1|apiKeyCipher/);
  });
});

describe('ProviderCredentialsService.setKey', () => {
  it('stores the trimmed key encrypted', async () => {
    const { svc, rows, crypto } = build();
    await svc.setKey(ProviderKind.deepgram, STT, '  dg-secret-key-1  ', 'admin-1');

    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0].apiKeyCipher).toString('utf8')).not.toContain('dg-secret-key-1');
    expect(crypto.decrypt({ cipher: rows[0].apiKeyCipher, keyVersion: rows[0].keyVersion })).toBe('dg-secret-key-1');
    expect(rows[0].updatedById).toBe('admin-1');
  });

  it.each(['short', 'x'.repeat(513), '   seven  '])('rejects a key of the wrong length: %j', async (key) => {
    const { svc, rows } = build();
    await expect(svc.setKey(ProviderKind.deepgram, STT, key, 'admin-1')).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(rows).toHaveLength(0);
  });

  it('replaces an existing key and keeps the provider active', async () => {
    const { svc, rows, crypto } = build([{ provider: ProviderKind.deepgram, key: 'dg-old-key-123', isActive: true }]);
    await svc.setKey(ProviderKind.deepgram, STT, 'dg-new-key-456', 'admin-1');

    expect(rows).toHaveLength(1);
    expect(rows[0].isActive).toBe(true);
    expect(crypto.decrypt({ cipher: rows[0].apiKeyCipher, keyVersion: 1 })).toBe('dg-new-key-456');
  });
});

describe('ProviderCredentialsService.activate', () => {
  it('refuses a provider without a key', async () => {
    const { svc } = build();
    await expect(svc.activate(ProviderKind.deepgram, STT, 'admin-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('activates one provider and turns the other off', async () => {
    const { svc, rows } = build([
      { provider: ProviderKind.deepgram, key: 'dg-secret-key-1', isActive: true },
      { provider: ProviderKind.elevenlabs, key: 'el-secret-key-1' },
    ]);
    const list = await svc.activate(ProviderKind.elevenlabs, STT, 'admin-1');

    expect(rows.filter((r) => r.isActive).map((r) => r.provider)).toEqual(['elevenlabs']);
    expect(list.filter((s) => s.active).map((s) => s.provider)).toEqual(['elevenlabs']);
  });

  it('is a no-op, without an audit entry, when already active', async () => {
    const { svc, audit } = build([{ provider: ProviderKind.deepgram, key: 'dg-secret-key-1', isActive: true }]);
    await svc.activate(ProviderKind.deepgram, STT, 'admin-1');
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('ProviderCredentialsService.removeKey and deactivate', () => {
  it('removing the key of the active provider leaves no provider active', async () => {
    const { svc } = build([{ provider: ProviderKind.deepgram, key: 'dg-secret-key-1', isActive: true }]);
    await svc.removeKey(ProviderKind.deepgram, STT, 'admin-1');

    expect((await svc.list(STT)).some((s) => s.configured || s.active)).toBe(false);
    await expect(svc.getActive(STT)).resolves.toBeNull();
  });

  it('removing a key that is not there is a quiet no-op', async () => {
    const { svc, audit } = build();
    await svc.removeKey(ProviderKind.deepgram, STT, 'admin-1');
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('turns a provider off', async () => {
    const { svc } = build([{ provider: ProviderKind.deepgram, key: 'dg-secret-key-1', isActive: true }]);
    const list = await svc.deactivate(ProviderKind.deepgram, STT, 'admin-1');
    expect(list.find((s) => s.provider === 'deepgram')).toMatchObject({ configured: true, active: false });
  });
});

describe('ProviderCredentialsService.test', () => {
  it('decrypts the key and asks the adapter', async () => {
    const { svc, adapters } = build([{ provider: ProviderKind.elevenlabs, key: 'el-secret-key-1' }]);
    await expect(svc.test(ProviderKind.elevenlabs, STT)).resolves.toEqual({ ok: true, message: 'Key works.' });
    expect(adapters.elevenlabs.testKey).toHaveBeenCalledWith('el-secret-key-1');
  });

  it('says so when no key is saved', async () => {
    const { svc } = build();
    await expect(svc.test(ProviderKind.deepgram, STT)).resolves.toEqual({
      ok: false,
      message: 'No key saved for Deepgram.',
    });
  });
});

describe('ProviderCredentialsService.getActive', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns the active adapter with its decrypted key, or null', async () => {
    const { svc, adapters } = build([{ provider: ProviderKind.deepgram, key: 'dg-secret-key-1', isActive: true }]);
    await expect(svc.getActive(STT)).resolves.toEqual({ adapter: adapters.deepgram, apiKey: 'dg-secret-key-1' });

    const empty = build();
    await expect(empty.svc.getActive(STT)).resolves.toBeNull();
  });

  it('caches for 60 seconds', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { svc, prisma } = build([{ provider: ProviderKind.deepgram, key: 'dg-secret-key-1', isActive: true }]);

    await svc.getActive(STT);
    await svc.getActive(STT);
    expect(prisma.providerCredential.findFirst).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_000_000 + 60_001);
    await svc.getActive(STT);
    expect(prisma.providerCredential.findFirst).toHaveBeenCalledTimes(2);
  });

  it('uses a replaced key at once, not the cached one', async () => {
    const { svc } = build([{ provider: ProviderKind.deepgram, key: 'dg-bad-key-000', isActive: true }]);
    await svc.getActive(STT); // warms the cache

    await svc.setKey(ProviderKind.deepgram, STT, 'dg-good-key-111', 'admin-1');
    await expect(svc.getActive(STT)).resolves.toMatchObject({ apiKey: 'dg-good-key-111' });
  });

  it('uses a newly activated provider at once', async () => {
    const { svc } = build([
      { provider: ProviderKind.deepgram, key: 'dg-secret-key-1', isActive: true },
      { provider: ProviderKind.elevenlabs, key: 'el-secret-key-1' },
    ]);
    await svc.getActive(STT);

    await svc.activate(ProviderKind.elevenlabs, STT, 'admin-1');
    await expect(svc.getActive(STT)).resolves.toMatchObject({ apiKey: 'el-secret-key-1' });
  });
});

describe('ProviderCredentialsService audit', () => {
  it('records every change with provider and capability, and never the key', async () => {
    const { svc, audit } = build([{ provider: ProviderKind.elevenlabs, key: 'el-secret-key-1' }]);
    await svc.setKey(ProviderKind.deepgram, STT, 'dg-secret-key-1', 'admin-1');
    await svc.activate(ProviderKind.deepgram, STT, 'admin-1');
    await svc.deactivate(ProviderKind.deepgram, STT, 'admin-1');
    await svc.removeKey(ProviderKind.deepgram, STT, 'admin-1');

    const calls = audit.record.mock.calls.map(([entry]) => entry as { action: string; after: unknown });
    expect(calls.map((c) => c.action)).toEqual([
      'provider.key.set',
      'provider.activated',
      'provider.deactivated',
      'provider.key.removed',
    ]);
    expect(calls[0]).toMatchObject({ actorId: 'admin-1', actorType: 'admin', entityType: 'ProviderCredential', after: { provider: 'deepgram', capability: STT } });
    expect(JSON.stringify(audit.record.mock.calls)).not.toMatch(/secret-key/);
  });
});
