import { BadRequestException, NotFoundException } from '@nestjs/common';

import { probeAudio } from '../../core/storage/audio-probe';
import { probeImage } from '../../core/storage/image-probe';
import { UnreadableUploadError } from '../../core/storage/storage-adapter.interface';
import { AssetKind, FileRole } from '../../generated/prisma/enums';
import { AUDIO_DESCRIPTOR } from '../assets/kinds/audio/audio.descriptor';
import { FONT_DESCRIPTOR } from '../assets/kinds/font/font.descriptor';
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
    kind: 'r2',
    createUploadTicket: jest.fn(async () => ({
      uploadUrl: 'https://acct.r2.cloudflarestorage.com/bucket/slimshot/audio/abc?X-Amz-Signature=sig',
      method: 'PUT' as const,
      headers: { 'Content-Type': 'audio/mpeg' },
      storageKey: 'slimshot/audio/abc',
      expiresAt: new Date(Date.now() + 900_000),
    })),
    verifyUpload: jest.fn(async (): Promise<typeof REMOTE> => REMOTE),
    getDeliveryUrl: jest.fn(() => REMOTE.deliveryUrl),
    delete: jest.fn(async (): Promise<void> => undefined),
  };

  const sessions = new Map<string, Record<string, unknown>>();
  if (overrides.session !== undefined && overrides.session !== null) {
    sessions.set(overrides.session.id as string, overrides.session);
  }

  const created: Record<string, unknown>[] = [];

  const prisma = {
    category: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        ({ 'cat-ui': { kind: 'audio' }, 'cat-font': { kind: 'font' } } as Record<string, { kind: string }>)[where.id] ?? null,
      ),
    },
    asset: {
      findFirst: jest.fn(async ({ where }: { where: { id: string } }): Promise<Record<string, unknown> | null> =>
        where.id === 'asset-1' ? { id: 'asset-1', kind: 'audio', status: 'published', deletedAt: null } : null,
      ),
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
      findMany: jest.fn(async (): Promise<Array<{ id: string; storageId: string; storageKey: string }>> => []),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    audioAsset: { upsert: jest.fn(async () => ({})) },
    $transaction: jest.fn(async (fn: unknown): Promise<unknown> =>
      typeof fn === 'function'
        ? (fn as (tx: unknown) => Promise<unknown>)(prisma)
        : Promise.all(fn as never),
    ),
  };

  const upload = {
    ticketTtlSeconds: 900,
    limits: {
      audio: { maxBytes: 52_428_800, mimeTypes: ['audio/mpeg', 'audio/wav'] },
      font: { maxBytes: 10_485_760, mimeTypes: ['font/ttf', 'font/otf'] },
    },
    cover: { maxBytes: 5_242_880, mimeTypes: ['image/jpeg', 'image/png', 'image/webp'] },
  };
  const cache = { bumpGeneration: jest.fn(async () => true) };

  const queue = { enqueueAssetProcessing: jest.fn(async () => 'job-1') };

  const svc = new IngestService(
    prisma as never,
    new KindRegistry([AUDIO_DESCRIPTOR, FONT_DESCRIPTOR]),
    { getDefault: jest.fn(async () => adapter), get: jest.fn(async () => adapter) } as never,
    upload,
    queue as never,
    { record: jest.fn(async () => undefined) } as never,
    cache as never,
  );

  return { svc, prisma, adapter, created, sessions, queue, cache };
}

describe('IngestService.createTicket', () => {
  const DTO = {
    kind: AssetKind.audio,
    filename: 'Rise Up.mp3',
    mimeType: 'audio/mpeg',
    byteSize: 812_340,
  };

  it('refuses a kind with no configured upload limits', async () => {
    const { svc } = build();
    (svc as unknown as { upload: { limits: Record<string, unknown> } }).upload.limits = {};
    await expect(svc.createTicket(DTO, 'admin-1')).rejects.toThrow(/not configured/i);
  });

  it('enforces the configured size limit', async () => {
    const { svc } = build();
    await expect(
      svc.createTicket({ ...DTO, byteSize: 52_428_801 }, 'admin-1'),
    ).rejects.toThrow(/exceeds the configured maximum/);
  });

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
    expect(JSON.stringify(res)).not.toMatch(/secret/i);
  });

  it('asks storage for a ticket bound to the exact declared size and type', async () => {
    const { svc, adapter } = build();
    await svc.createTicket(DTO, 'admin-1');
    expect(adapter.createUploadTicket).toHaveBeenCalledWith({
      folder: 'slimshot/audio',
      filename: 'Rise Up.mp3',
      mimeType: 'audio/mpeg',
      byteSize: 812_340,
      ttlSeconds: 900,
    });
  });

  it('files the new sound under the chosen category', async () => {
    const { svc, prisma } = build();
    await svc.createTicket({ ...DTO, categoryId: 'cat-ui' }, 'admin-1');
    expect(prisma.asset.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ categoryId: 'cat-ui' }) }),
    );
  });

  it('refuses a category of another kind before creating anything', async () => {
    const { svc, prisma, adapter } = build();
    await expect(svc.createTicket({ ...DTO, categoryId: 'cat-font' }, 'admin-1')).rejects.toMatchObject({ status: 422 });
    expect(prisma.asset.create).not.toHaveBeenCalled();
    expect(adapter.createUploadTicket).not.toHaveBeenCalled();
  });

  it('tells the client how to upload: method, URL and the headers to send', async () => {
    const { svc } = build();
    const res = await svc.createTicket(DTO, 'admin-1');
    expect(res).toMatchObject({
      method: 'PUT',
      headers: { 'Content-Type': 'audio/mpeg' },
      uploadUrl: expect.stringContaining('X-Amz-Signature'),
      storageKey: 'slimshot/audio/abc',
    });
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
      createdById: 'admin-1',
      asset: { kind: AssetKind.audio },
    };
  }

  it('reads byte size and duration from the provider, not the client', async () => {
    const { svc, adapter, created } = build({ session: pendingSession() });
    await svc.finalize({ sessionId: 'sess-1' }, 'admin-1');

    // The original is checked as audio, from its bytes.
    expect(adapter.verifyUpload).toHaveBeenCalledWith('slimshot/audio/abc', probeAudio);
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

  it('leaves the asset publishable when no processor will advance it', async () => {
    const { svc, prisma } = build({ session: pendingSession() });
    const result = await svc.finalize({ sessionId: 'sess-1' }, 'admin-1');

    // No worker consumes the queue yet, so parking the asset in `processing`
    // would strand it: publish() accepts only `ready`/`archived` and nothing
    // else writes `ready`. Finalize must land somewhere publishable.
    expect(prisma.asset.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ready' }) }),
    );
    // The reported status must match what was persisted, not a constant.
    expect(result.status).toBe('ready');
  });

  it('does not enqueue processing jobs while no worker consumes them', async () => {
    const { svc, queue } = build({ session: pendingSession() });
    await svc.finalize({ sessionId: 'sess-1' }, 'admin-1');

    expect(queue.enqueueAssetProcessing).not.toHaveBeenCalled();
  });

  it('refuses to finalize an upload session opened by another admin', async () => {
    const { svc } = build({ session: pendingSession() });

    await expect(
      svc.finalize({ sessionId: 'sess-1' }, 'a-different-admin'),
    ).rejects.toThrow(/belongs to a different account/);
  });

  it('rejects a file whose real type is not allowed, whatever was declared', async () => {
    const { svc, adapter, prisma } = build({ session: pendingSession() });
    // Declared audio/mpeg at ticket time; an MP4 actually landed.
    adapter.verifyUpload.mockResolvedValue({
      storageKey: 'slimshot/audio/abc',
      byteSize: 812_340,
      format: 'mp4',
      mimeType: 'video/mp4',
      durationMs: 145_200,
      deliveryUrl: 'https://cdn/abc.mp4',
    });

    await expect(svc.finalize({ sessionId: 'sess-1' }, 'admin-1')).rejects.toThrow(
      /not accepted for audio/,
    );
    expect(prisma.asset.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
    // R2 keeps whatever it is sent: a refused file is removed, not left behind.
    expect(adapter.delete).toHaveBeenCalledWith('slimshot/audio/abc');
  });

  it('refuses audio whose real format is not the one declared', async () => {
    // A WAV renamed to .mp3: R2 would serve it as audio/mpeg, which players reject.
    const { svc, adapter, prisma } = build({ session: pendingSession() });
    adapter.verifyUpload.mockResolvedValue({ ...REMOTE, format: 'wav', mimeType: 'audio/wav' });

    await expect(svc.finalize({ sessionId: 'sess-1' }, 'admin-1')).rejects.toThrow(
      'The file is WAV audio (audio/wav), but it was uploaded as audio/mpeg. Give it the right extension and upload it again.',
    );
    expect(prisma.asset.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
    expect(adapter.delete).toHaveBeenCalledWith('slimshot/audio/abc');
    expect(prisma.assetFile.create).not.toHaveBeenCalled();
  });

  it('refuses a file that is not audio with the reason, and removes it', async () => {
    const { svc, adapter, prisma } = build({ session: pendingSession() });
    const reason = 'The file is not a supported audio file (MP3, WAV, AAC, OGG or FLAC).';
    adapter.verifyUpload.mockRejectedValue(new UnreadableUploadError(reason));

    const error = await svc.finalize({ sessionId: 'sess-1' }, 'admin-1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toBe(reason);
    expect(prisma.asset.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
    expect(adapter.delete).toHaveBeenCalledWith('slimshot/audio/abc');
  });

  it('refuses a stored file over the size cap, whatever the ticket said', async () => {
    const { svc, adapter } = build({ session: pendingSession() });
    adapter.verifyUpload.mockResolvedValue({ ...REMOTE, byteSize: 52_428_801 });

    await expect(svc.finalize({ sessionId: 'sess-1' }, 'admin-1')).rejects.toThrow(
      /exceeds the configured maximum/,
    );
    expect(adapter.delete).toHaveBeenCalledWith('slimshot/audio/abc');
  });

  it('keeps the real reason when removing the refused file also fails', async () => {
    const { svc, adapter } = build({ session: pendingSession() });
    adapter.verifyUpload.mockResolvedValue({ ...REMOTE, format: 'wav', mimeType: 'audio/wav' });
    adapter.delete.mockRejectedValue(new Error('R2 unreachable'));

    await expect(svc.finalize({ sessionId: 'sess-1' }, 'admin-1')).rejects.toThrow(/WAV audio/);
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

    await expect(svc.finalize({ sessionId: 'sess-1' }, 'admin-1')).rejects.toThrow(
      /could not be verified in storage: Uploaded object not found/,
    );
    expect(prisma.asset.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
    // Nothing is known to be there, or storage is unreachable: deleting is pointless.
    expect(adapter.delete).not.toHaveBeenCalled();
  });
});

describe('IngestService covers', () => {
  const COVER = {
    role: FileRole.thumbnail,
    assetId: 'asset-1',
    filename: 'cover.PNG',
    mimeType: 'image/png',
    byteSize: 20_000,
  };
  const OLD = [{ id: 'f-old', storageId: 'prov-1', storageKey: 'slimshot/covers/old.png' }];
  const COVER_REMOTE = {
    storageKey: 'slimshot/covers/new.png',
    byteSize: 20_000,
    format: 'png',
    mimeType: 'image/png',
    deliveryUrl: 'https://cdn.test/slimshot/covers/new.png',
  };

  function coverSession(overrides: Record<string, unknown> = {}) {
    return {
      id: 'sess-c',
      assetId: 'asset-1',
      role: FileRole.thumbnail,
      storageId: 'prov-1',
      storageKey: 'slimshot/covers/new.png',
      state: 'pending',
      expiresAt: new Date(Date.now() + 600_000),
      declaredMime: 'image/png',
      declaredSize: 20_000,
      createdById: 'admin-1',
      asset: { kind: AssetKind.audio, status: 'published' },
      ...overrides,
    };
  }

  it('tickets a cover for an existing sound without creating a new asset', async () => {
    const { svc, prisma, adapter } = build();
    const res = await svc.createTicket(COVER as never, 'admin-1');
    expect(prisma.asset.create).not.toHaveBeenCalled();
    expect(adapter.createUploadTicket).toHaveBeenCalledWith(
      expect.objectContaining({ folder: 'slimshot/covers', mimeType: 'image/png', byteSize: 20_000 }),
    );
    expect(prisma.uploadSession.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ assetId: 'asset-1', role: 'thumbnail' }) }),
    );
    expect(res.assetId).toBe('asset-1');
  });

  it.each([
    ['a type that is not an image', { mimeType: 'image/gif' }, /not an accepted cover type/],
    ['a cover over the cap', { byteSize: 5_242_881 }, /exceeds the cover maximum/],
  ])('refuses %s at ticket time', async (_name, patch, message) => {
    const { svc } = build();
    await expect(svc.createTicket({ ...COVER, ...patch } as never, 'admin-1')).rejects.toThrow(message);
  });

  it('404s a cover ticket for an unknown or deleted sound', async () => {
    const { svc } = build();
    await expect(svc.createTicket({ ...COVER, assetId: 'gone' } as never, 'admin-1')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('replaces the old cover: new row in, old row and file out, cache cleared', async () => {
    const { svc, prisma, adapter, cache } = build({ session: coverSession() });
    adapter.verifyUpload.mockResolvedValue(COVER_REMOTE as never);
    prisma.assetFile.findMany.mockResolvedValue(OLD);

    await expect(svc.finalize({ sessionId: 'sess-c' }, 'admin-1')).resolves.toEqual({
      assetId: 'asset-1',
      status: 'published',
    });

    expect(adapter.verifyUpload).toHaveBeenCalledWith('slimshot/covers/new.png', probeImage);
    expect(prisma.assetFile.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['f-old'] } } });
    expect(prisma.assetFile.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: 'thumbnail', storageKey: 'slimshot/covers/new.png' }),
      }),
    );
    expect(adapter.delete).toHaveBeenCalledWith('slimshot/covers/old.png');
    expect(cache.bumpGeneration).toHaveBeenCalledWith('catalog:audio');
    // A cover never changes where the sound is in its lifecycle.
    expect(prisma.asset.update).not.toHaveBeenCalled();
  });

  it('a refused cover leaves the asset status alone and removes only the new file', async () => {
    const { svc, prisma, adapter } = build({ session: coverSession() });
    adapter.verifyUpload.mockRejectedValue(
      new UnreadableUploadError('The file is not a supported image (JPEG, PNG or WebP).'),
    );
    await expect(svc.finalize({ sessionId: 'sess-c' }, 'admin-1')).rejects.toThrow('not a supported image');
    expect(prisma.asset.update).not.toHaveBeenCalled();
    expect(adapter.delete).toHaveBeenCalledWith('slimshot/covers/new.png');
    expect(adapter.delete).toHaveBeenCalledTimes(1);
  });

  it('a cover that cannot be read from storage leaves the asset status alone', async () => {
    const { svc, prisma, adapter } = build({ session: coverSession() });
    adapter.verifyUpload.mockRejectedValue(new Error('Uploaded object not found in storage'));
    await expect(svc.finalize({ sessionId: 'sess-c' }, 'admin-1')).rejects.toThrow(/could not be verified/);
    expect(prisma.asset.update).not.toHaveBeenCalled();
  });

  it('refuses a PNG that was declared as JPEG', async () => {
    const { svc, adapter } = build({ session: coverSession({ declaredMime: 'image/jpeg' }) });
    adapter.verifyUpload.mockResolvedValue(COVER_REMOTE as never);
    await expect(svc.finalize({ sessionId: 'sess-c' }, 'admin-1')).rejects.toThrow(
      'The file is PNG (image/png), but it was uploaded as image/jpeg.',
    );
  });

  it('keeps the new cover when deleting the old file fails', async () => {
    const { svc, prisma, adapter } = build({ session: coverSession() });
    adapter.verifyUpload.mockResolvedValue(COVER_REMOTE as never);
    prisma.assetFile.findMany.mockResolvedValue(OLD);
    adapter.delete.mockRejectedValue(new Error('R2 unreachable'));
    await expect(svc.finalize({ sessionId: 'sess-c' }, 'admin-1')).resolves.toMatchObject({ assetId: 'asset-1' });
  });

  it('removes a cover: rows, files and cache', async () => {
    const { svc, prisma, adapter, cache } = build();
    prisma.assetFile.findMany.mockResolvedValue(OLD);
    await svc.removeCover('asset-1', 'admin-1');
    expect(prisma.assetFile.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['f-old'] } } });
    expect(adapter.delete).toHaveBeenCalledWith('slimshot/covers/old.png');
    expect(cache.bumpGeneration).toHaveBeenCalledWith('catalog:audio');
  });

  it('removing a cover from an unknown sound is a 404', async () => {
    const { svc } = build();
    await expect(svc.removeCover('gone', 'admin-1')).rejects.toMatchObject({ status: 404 });
  });
});

describe('IngestService font tickets', () => {
  const FONT = { kind: AssetKind.font, filename: 'Lato-Regular.ttf', mimeType: 'font/ttf', byteSize: 656_568 };

  it('tickets a font upload into the fonts folder', async () => {
    const { svc, adapter } = build();
    await svc.createTicket(FONT, 'admin-1');
    expect(adapter.createUploadTicket).toHaveBeenCalledWith(
      expect.objectContaining({ folder: 'slimshot/fonts', mimeType: 'font/ttf', byteSize: 656_568 }),
    );
  });

  it('refuses a web font type', async () => {
    const { svc } = build();
    await expect(svc.createTicket({ ...FONT, filename: 'Lato.woff2', mimeType: 'font/woff2' }, 'admin-1')).rejects.toThrow(
      /not an accepted type for font/,
    );
  });

  it('refuses a font over 10 MB', async () => {
    const { svc } = build();
    await expect(svc.createTicket({ ...FONT, byteSize: 10_485_761 }, 'admin-1')).rejects.toThrow(/exceeds/);
  });
});
