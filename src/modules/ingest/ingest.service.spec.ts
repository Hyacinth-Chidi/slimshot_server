import { BadRequestException, NotFoundException } from '@nestjs/common';

import { AssetKind, FileRole } from '../../generated/prisma/enums';
import { AUDIO_DESCRIPTOR } from '../assets/kinds/audio/audio.descriptor';
import { KindRegistry } from '../assets/kind-registry';
import { IngestService } from './ingest.service';

const REMOTE = {
  storageKey: 'slimshot/audio/abc',
  byteSize: 812_340,
  format: 'mp3',
  mimeType: 'audio/mpeg',
  durationMs: 145_200,
  deliveryUrl: 'https://cdn/abc.mp3',
};

function build(overrides: { session?: Record<string, unknown> | null } = {}) {
  const adapter = {
    id: 'prov-1',
    kind: 'cloudinary',
    createUploadTicket: jest.fn(async () => ({
      uploadUrl: 'https://api.cloudinary.com/v1_1/demo/video/upload',
      storageKey: 'slimshot/audio/abc',
      fields: { signature: 'sig', api_key: 'key' },
      expiresAt: new Date(Date.now() + 900_000),
    })),
    verifyUpload: jest.fn(async () => REMOTE),
    getDeliveryUrl: jest.fn(() => REMOTE.deliveryUrl),
  };

  const sessions = new Map<string, Record<string, unknown>>();
  if (overrides.session !== undefined && overrides.session !== null) {
    sessions.set(overrides.session.id as string, overrides.session);
  }

  const created: Record<string, unknown>[] = [];

  const prisma = {
    asset: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'asset-1',
        ...data,
      })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'asset-1',
        ...data,
      })),
    },
    uploadSession: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: 'sess-1', ...data };
        sessions.set('sess-1', row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        sessions.get(where.id) ?? null,
      ),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = sessions.get(where.id);
        if (row) Object.assign(row, data);
        return row;
      }),
    },
    assetFile: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return data;
      }),
    },
    audioAsset: { upsert: jest.fn(async () => ({})) },
    $transaction: jest.fn(async (fn: unknown): Promise<unknown> =>
      typeof fn === 'function'
        ? (fn as (tx: unknown) => Promise<unknown>)(prisma)
        : Promise.all(fn as never),
    ),
  };

  const settingsValues: Record<string, unknown> = {
    'upload.audio.mimeTypes': ['audio/mpeg', 'audio/wav'],
    'upload.audio.maxBytes': 52_428_800,
    'upload.ticketTtlSeconds': 900,
  };

  const svc = new IngestService(
    prisma as never,
    new KindRegistry([AUDIO_DESCRIPTOR]),
    { getDefault: jest.fn(async () => adapter), get: jest.fn(async () => adapter) } as never,
    { get: jest.fn(async (k: string) => settingsValues[k]) } as never,
    { enqueueAssetProcessing: jest.fn(async () => 'job-1') } as never,
    { record: jest.fn(async () => undefined) } as never,
  );

  return { svc, prisma, adapter, created, sessions };
}

describe('IngestService.createTicket', () => {
  const DTO = {
    kind: AssetKind.audio,
    filename: 'Rise Up.mp3',
    mimeType: 'audio/mpeg',
    byteSize: 812_340,
  };

  it('creates a draft asset and an upload session', async () => {
    const { svc, prisma } = build();
    const res = await svc.createTicket(DTO, 'admin-1');

    expect(prisma.asset.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'audio', status: 'draft' }),
      }),
    );
    expect(res.sessionId).toBe('sess-1');
  });

  it('derives a slug from the filename when no title is given', async () => {
    const { svc, prisma } = build();
    await svc.createTicket(DTO, 'admin-1');

    const data = prisma.asset.create.mock.calls[0][0].data as Record<string, string>;
    expect(data.slug).toMatch(/^rise-up/);
    expect(data.title).toBe('Rise Up');
  });

  it('rejects a mime type the kind does not accept', async () => {
    const { svc } = build();
    await expect(
      svc.createTicket({ ...DTO, mimeType: 'application/zip' }, 'admin-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a file larger than the configured cap', async () => {
    const { svc } = build();
    await expect(
      svc.createTicket({ ...DTO, byteSize: 99_999_999 }, 'admin-1'),
    ).rejects.toThrow(/exceeds/i);
  });

  it('never returns the provider api secret in the ticket', async () => {
    const { svc } = build();
    const res = await svc.createTicket(DTO, 'admin-1');
    expect(JSON.stringify(res)).not.toContain('apiSecret');
  });
});

describe('IngestService.finalize', () => {
  function pendingSession() {
    return {
      id: 'sess-1',
      assetId: 'asset-1',
      role: FileRole.original,
      storageId: 'prov-1',
      storageKey: 'slimshot/audio/abc',
      state: 'pending',
      expiresAt: new Date(Date.now() + 600_000),
      declaredMime: 'audio/mpeg',
      declaredSize: 812_340,
      asset: { kind: AssetKind.audio },
    };
  }

  it('reads byte size and duration from the provider, not the client', async () => {
    const { svc, adapter, created } = build({ session: pendingSession() });
    await svc.finalize({ sessionId: 'sess-1' }, 'admin-1');

    expect(adapter.verifyUpload).toHaveBeenCalledWith('slimshot/audio/abc');
    expect(created[0].byteSize).toBe(812_340);
    expect(created[0].durationMs).toBe(145_200);
  });

  it('writes the typed detail row from provider metadata', async () => {
    const { svc, prisma } = build({ session: pendingSession() });
    await svc.finalize({ sessionId: 'sess-1' }, 'admin-1');

    expect(prisma.audioAsset.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ durationMs: 145_200 }),
      }),
    );
  });

  it('moves the asset to processing and enqueues the kind processors', async () => {
    const { svc, prisma } = build({ session: pendingSession() });
    await svc.finalize({ sessionId: 'sess-1' }, 'admin-1');

    expect(prisma.asset.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'processing' }) }),
    );
  });

  it('marks the session finalized so it cannot be replayed', async () => {
    const { svc, sessions } = build({ session: pendingSession() });
    await svc.finalize({ sessionId: 'sess-1' }, 'admin-1');
    expect(sessions.get('sess-1')!.state).toBe('finalized');
  });

  it('rejects a second finalize of the same session', async () => {
    const { svc } = build({ session: { ...pendingSession(), state: 'finalized' } });
    await expect(svc.finalize({ sessionId: 'sess-1' }, 'admin-1')).rejects.toThrow(
      /already finalized/i,
    );
  });

  it('rejects an expired session', async () => {
    const { svc } = build({
      session: { ...pendingSession(), expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(svc.finalize({ sessionId: 'sess-1' }, 'admin-1')).rejects.toThrow(
      /expired/i,
    );
  });

  it('rejects an unknown session id', async () => {
    const { svc } = build({ session: null });
    await expect(svc.finalize({ sessionId: 'nope' }, 'admin-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('marks the asset failed when the object is not in storage', async () => {
    const { svc, adapter, prisma } = build({ session: pendingSession() });
    adapter.verifyUpload.mockRejectedValue(new Error('Uploaded object not found'));

    await expect(svc.finalize({ sessionId: 'sess-1' }, 'admin-1')).rejects.toThrow();
    expect(prisma.asset.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
  });
});
