import { BadRequestException } from '@nestjs/common';

import { AssetKind, FileRole } from '../../generated/prisma/enums';
import { AssetKindDescriptor } from './asset-kind.interface';
import { KindRegistry } from './kind-registry';

const FAKE: AssetKindDescriptor = {
  kind: AssetKind.audio,
  label: 'Audio',
  accepts: {
    mimeTypesSetting: 'upload.audio.mimeTypes',
    maxBytesSetting: 'upload.audio.maxBytes',
    extensions: ['.mp3', '.wav'],
  },
  fileRoles: [
    { role: FileRole.original, required: true, multiple: false },
    { role: FileRole.preview, required: false, multiple: false },
  ],
  detailDto: class {},
  processors: ['audio:preview'],
  buildDetail: (remote) => ({ durationMs: remote.durationMs ?? 0 }),
  toPublicDto: () => ({
    id: 'x',
    slug: 'x',
    kind: AssetKind.audio,
    title: 'x',
    author: 'x',
    tags: [],
    files: {},
    detail: {},
    stats: { downloadCount: 0 },
  }),
};

describe('KindRegistry', () => {
  it('resolves a registered descriptor by kind', () => {
    const reg = new KindRegistry([FAKE]);
    expect(reg.get(AssetKind.audio).label).toBe('Audio');
  });

  it('throws for an unregistered kind rather than returning undefined', () => {
    const reg = new KindRegistry([FAKE]);
    expect(() => reg.get(AssetKind.font)).toThrow(/no descriptor registered/i);
  });

  it('lists every registered descriptor', () => {
    expect(new KindRegistry([FAKE]).all()).toHaveLength(1);
  });

  it('rejects duplicate registrations for the same kind at construction', () => {
    expect(() => new KindRegistry([FAKE, FAKE])).toThrow(/duplicate/i);
  });

  it('accepts a file matching the declared mime types and size', () => {
    const reg = new KindRegistry([FAKE]);
    expect(() =>
      reg.assertAccepts(AssetKind.audio, 'audio/mpeg', 1000, ['audio/mpeg'], 50_000),
    ).not.toThrow();
  });

  it('rejects a mime type the kind does not accept', () => {
    const reg = new KindRegistry([FAKE]);
    expect(() =>
      reg.assertAccepts(AssetKind.audio, 'application/zip', 1000, ['audio/mpeg'], 50_000),
    ).toThrow(BadRequestException);
  });

  it('rejects a file over the configured size cap', () => {
    const reg = new KindRegistry([FAKE]);
    expect(() =>
      reg.assertAccepts(AssetKind.audio, 'audio/mpeg', 90_000, ['audio/mpeg'], 50_000),
    ).toThrow(/exceeds/i);
  });

  it('names the required file roles for a kind', () => {
    const reg = new KindRegistry([FAKE]);
    expect(reg.requiredRoles(AssetKind.audio)).toEqual([FileRole.original]);
  });
});
