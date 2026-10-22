import { AssetKind, FileRole } from '../../../../generated/prisma/enums';
import { KIND_DESCRIPTORS } from '../index';
import { FONT_DESCRIPTOR } from './font.descriptor';

describe('FONT_DESCRIPTOR', () => {
  it('accepts TTF and OTF files, one original face and its preview', () => {
    expect(FONT_DESCRIPTOR).toMatchObject({
      kind: AssetKind.font,
      label: 'Fonts',
      accepts: { extensions: ['.ttf', '.otf'] },
      processors: [],
    });
    expect(FONT_DESCRIPTOR.fileRoles).toEqual([
      { role: FileRole.original, required: true, multiple: false },
      { role: FileRole.specimen, required: false, multiple: false },
    ]);
  });

  it('shows the preview but never the font file in its public shape', () => {
    const file = (role: FileRole, url: string) => ({
      role,
      deliveryUrl: url,
      byteSize: 10,
      format: 'x',
      durationMs: null,
      width: null,
      height: null,
      variant: null,
    });
    const dto = FONT_DESCRIPTOR.toPublicDto({
      id: 'f1',
      slug: 'lato',
      kind: AssetKind.font,
      title: 'Lato Regular',
      authorName: 'SlimShot',
      downloadCount: 2,
      files: [file(FileRole.original, 'https://cdn/f.ttf'), file(FileRole.specimen, 'https://cdn/p.png')],
    });
    expect(dto.files).toEqual({ specimen: expect.objectContaining({ url: 'https://cdn/p.png' }) });
    expect(JSON.stringify(dto)).not.toContain('f.ttf');
  });
});

describe('KIND_DESCRIPTORS', () => {
  it('registers audio first, then fonts', () => {
    expect(KIND_DESCRIPTORS.map((d) => d.kind)).toEqual([AssetKind.audio, AssetKind.font]);
  });
});
