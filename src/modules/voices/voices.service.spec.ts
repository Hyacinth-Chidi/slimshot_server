import { HttpException } from '@nestjs/common';

import { ProviderError } from '../providers/provider-error';
import { SAMPLE_TEXT, VoicesService } from './voices.service';

interface VoiceRow {
  id: string;
  provider: string;
  providerVoiceId: string;
  label: string;
  sortOrder: number;
  enabled: boolean;
  sampleStorageId: string | null;
  sampleStorageKey: string | null;
  sampleUrl: string | null;
}

const voice = (o: Partial<VoiceRow> & { id: string }): VoiceRow => ({
  provider: 'xai',
  providerVoiceId: o.id,
  label: o.id,
  sortOrder: 0,
  enabled: false,
  sampleStorageId: null,
  sampleStorageKey: null,
  sampleUrl: null,
  ...o,
});

function ordered(rows: VoiceRow[]): VoiceRow[] {
  return [...rows].sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
}

function build(seed: VoiceRow[] = [], { active = true } = {}) {
  const rows = seed.map((r) => ({ ...r }));
  const prisma = {
    voice: {
      findMany: jest.fn(async ({ where }: { where?: Record<string, unknown> } = {}) =>
        ordered(
          rows.filter(
            (r) =>
              (where?.enabled === undefined || r.enabled === where.enabled) &&
              (where?.provider === undefined || r.provider === where.provider) &&
              (where?.sampleUrl === undefined || r.sampleUrl !== null),
          ),
        ),
      ),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null),
      findFirst: jest.fn(
        async ({ where }: { where: { id: string; enabled?: boolean } }) =>
          rows.find((r) => r.id === where.id && (where.enabled === undefined || r.enabled === where.enabled)) ?? null,
      ),
      createMany: jest.fn(async ({ data }: { data: Array<Partial<VoiceRow>> }) => {
        data.forEach((d, i) => rows.push(voice({ id: `new-${rows.length + i}`, ...d } as VoiceRow)));
        return { count: data.length };
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<VoiceRow> }) =>
        Object.assign(rows.find((r) => r.id === where.id) as VoiceRow, data),
      ),
    },
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const adapter = {
    kind: 'xai',
    listVoices: jest.fn(async () => [] as Array<{ providerVoiceId: string; name: string | null }>),
    synthesize: jest.fn(async () => Buffer.from([0xff, 0xfb])),
  };
  const credentials = {
    getActiveTextToSpeech: jest.fn(async () => (active ? { adapter, apiKey: 'k' } : null)),
  };
  const store = {
    id: 'st1',
    putObject: jest.fn(async () => undefined),
    getDeliveryUrl: jest.fn((key: string) => `https://cdn.example/${key}`),
    delete: jest.fn(async () => undefined),
  };
  const storage = { getDefault: jest.fn(async () => store), get: jest.fn(async () => store) };
  const audit = { record: jest.fn(async () => undefined) };
  const svc = new VoicesService(prisma as never, credentials as never, storage as never, audit as never);
  return { svc, rows, prisma, adapter, store, audit };
}

async function errorOf(p: Promise<unknown>): Promise<HttpException> {
  return p.then(
    () => {
      throw new Error('expected a failure');
    },
    (e: HttpException) => e,
  );
}

describe('VoicesService.sync', () => {
  it('adds new voices switched off, keeps known ones as they are', async () => {
    const { svc, rows, adapter } = build([
      voice({ id: 'v1', providerVoiceId: 'eve', label: 'Narrator', enabled: true, sampleUrl: 'u', sortOrder: 0 }),
      voice({ id: 'v2', providerVoiceId: 'old', label: 'Old', sortOrder: 1 }),
    ]);
    adapter.listVoices.mockResolvedValue([
      { providerVoiceId: 'eve', name: 'Eve' },
      { providerVoiceId: 'ara', name: 'Ara' },
      { providerVoiceId: 'rex', name: null },
    ]);

    await svc.sync('admin-1');

    expect(rows.find((r) => r.id === 'v1')).toMatchObject({ label: 'Narrator', enabled: true, sortOrder: 0 });
    // A voice xAI no longer lists stays: a project's choice never vanishes mid-session.
    expect(rows.find((r) => r.providerVoiceId === 'old')).toBeDefined();
    expect(rows.find((r) => r.providerVoiceId === 'ara')).toMatchObject({ label: 'Ara', enabled: false, sortOrder: 2 });
    expect(rows.find((r) => r.providerVoiceId === 'rex')).toMatchObject({ label: 'rex', enabled: false, sortOrder: 3 });
    expect(rows.filter((r) => r.providerVoiceId === 'eve')).toHaveLength(1);
  });

  it('without an active text-to-speech key says so', async () => {
    const error = await errorOf(build([], { active: false }).svc.sync('admin-1'));
    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toMatchObject({ code: 'TTS_UNAVAILABLE' });
  });
});

describe('VoicesService.update', () => {
  it('a voice cannot be switched on without a sample', async () => {
    const { svc, rows } = build([voice({ id: 'v1' })]);
    const error = await errorOf(svc.update('v1', { enabled: true }, 'admin-1'));
    expect(error.getStatus()).toBe(409);
    expect(rows[0].enabled).toBe(false);
  });

  it('renames and switches on a sampled voice, and audits it', async () => {
    const { svc, rows, audit } = build([voice({ id: 'v1', sampleUrl: 'u' })]);
    await svc.update('v1', { label: '  Eve  ', enabled: true }, 'admin-1');
    expect(rows[0]).toMatchObject({ label: 'Eve', enabled: true });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'voice.updated', entityType: 'Voice', entityId: 'v1' }));
  });

  it('answers 404 for an unknown voice', async () => {
    expect((await errorOf(build().svc.update('nope', { label: 'X' }, 'admin-1'))).getStatus()).toBe(404);
  });
});

describe('VoicesService.reorder', () => {
  it('must name every voice exactly once', async () => {
    const { svc, rows } = build([voice({ id: 'v1', sortOrder: 0 }), voice({ id: 'v2', sortOrder: 1 })]);
    for (const ids of [['v2'], ['v1', 'v1'], ['v1', 'v2', 'v3']]) {
      const error = await errorOf(svc.reorder(ids, 'admin-1'));
      expect(error.getStatus()).toBe(422);
    }
    expect(rows.map((r) => r.sortOrder)).toEqual([0, 1]);
  });

  it('saves the order given', async () => {
    const { svc, rows } = build([voice({ id: 'v1', sortOrder: 0 }), voice({ id: 'v2', sortOrder: 1 })]);
    await svc.reorder(['v2', 'v1'], 'admin-1');
    expect(rows.find((r) => r.id === 'v2')?.sortOrder).toBe(0);
    expect(rows.find((r) => r.id === 'v1')?.sortOrder).toBe(1);
  });
});

describe('VoicesService.makeSample', () => {
  it('stores an MP3 of the sample sentence and drops the old one', async () => {
    const { svc, rows, adapter, store } = build([
      voice({ id: 'v1', providerVoiceId: 'eve', sampleStorageId: 'st1', sampleStorageKey: 'slimshot/voices/samples/old.mp3', sampleUrl: 'old' }),
    ]);
    await svc.makeSample('v1', 'admin-1');

    expect(SAMPLE_TEXT).toBe('Hi! This is how I sound in your video.');
    expect(adapter.synthesize).toHaveBeenCalledWith({ text: SAMPLE_TEXT, voiceId: 'eve' }, 'k');
    const [key, body, type] = store.putObject.mock.calls[0] as unknown as [string, Buffer, string];
    expect(key).toMatch(/^slimshot\/voices\/samples\/[0-9a-f-]+\.mp3$/);
    expect([...body]).toEqual([0xff, 0xfb]);
    expect(type).toBe('audio/mpeg');
    expect(rows[0]).toMatchObject({ sampleStorageId: 'st1', sampleStorageKey: key, sampleUrl: `https://cdn.example/${key}` });
    expect(store.delete).toHaveBeenCalledWith('slimshot/voices/samples/old.mp3');
  });

  it('a failed delete of the old sample is only logged', async () => {
    const { svc, store } = build([
      voice({ id: 'v1', sampleStorageId: 'st1', sampleStorageKey: 'slimshot/voices/samples/old.mp3', sampleUrl: 'old' }),
    ]);
    store.delete.mockRejectedValue(new Error('storage down'));
    await expect(svc.makeSample('v1', 'admin-1')).resolves.toBeDefined();
  });

  it('a provider refusal is said, and the old sample stays', async () => {
    const { svc, rows, adapter, store } = build([voice({ id: 'v1', sampleUrl: 'old', sampleStorageKey: 'k-old', sampleStorageId: 'st1' })]);
    adapter.synthesize.mockRejectedValue(new ProviderError('xai' as never, 400, 'Unknown voice.'));
    const error = await errorOf(svc.makeSample('v1', 'admin-1'));
    expect(error.getStatus()).toBe(502);
    expect(error.getResponse()).toMatchObject({ code: 'PROVIDER_FAILED' });
    expect(rows[0].sampleUrl).toBe('old');
    expect(store.putObject).not.toHaveBeenCalled();
  });
});

describe('VoicesService for the app and the jobs', () => {
  it('the app sees only enabled voices with a sample, in order', async () => {
    const { svc } = build([
      voice({ id: 'v1', label: 'Zed', enabled: true, sampleUrl: 'u1', sortOrder: 1 }),
      voice({ id: 'v2', label: 'Ara', enabled: true, sampleUrl: 'u2', sortOrder: 0 }),
      voice({ id: 'v3', label: 'Off', enabled: false, sampleUrl: 'u3', sortOrder: 2 }),
    ]);
    await expect(svc.listForApp()).resolves.toEqual([
      { id: 'v2', label: 'Ara', sampleUrl: 'u2' },
      { id: 'v1', label: 'Zed', sampleUrl: 'u1' },
    ]);
  });

  it('a job may only use an enabled voice', async () => {
    const { svc } = build([voice({ id: 'v1', enabled: true }), voice({ id: 'v2', enabled: false })]);
    await expect(svc.voiceForJob('v1')).resolves.toMatchObject({ id: 'v1' });
    await expect(svc.voiceForJob('v2')).resolves.toBeNull();
    await expect(svc.voiceForJob('nope')).resolves.toBeNull();
  });
});
