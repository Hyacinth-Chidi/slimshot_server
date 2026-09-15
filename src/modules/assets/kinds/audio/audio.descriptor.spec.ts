import { AssetKind, FileRole } from '../../../../generated/prisma/enums';
import { AUDIO_DESCRIPTOR } from './audio.descriptor';

describe('AUDIO_DESCRIPTOR', () => {
  it('declares the audio kind and requires an original file', () => {
    expect(AUDIO_DESCRIPTOR.kind).toBe(AssetKind.audio);
    const original = AUDIO_DESCRIPTOR.fileRoles.find(
      (r) => r.role === FileRole.original,
    );
    expect(original?.required).toBe(true);
  });

  it('points at settings keys rather than hardcoding limits', () => {
    expect(AUDIO_DESCRIPTOR.accepts.maxBytesSetting).toBe('upload.audio.maxBytes');
    expect(AUDIO_DESCRIPTOR.accepts.mimeTypesSetting).toBe('upload.audio.mimeTypes');
  });

  it('builds the detail row from provider-verified duration', () => {
    const detail = AUDIO_DESCRIPTOR.buildDetail({
      storageKey: 'k',
      byteSize: 100,
      format: 'mp3',
      mimeType: 'audio/mpeg',
      durationMs: 145_200,
      deliveryUrl: 'https://cdn/x.mp3',
    });
    expect(detail).toEqual({ durationMs: 145_200 });
  });

  it('defaults duration to zero when the provider reports none', () => {
    const detail = AUDIO_DESCRIPTOR.buildDetail({
      storageKey: 'k',
      byteSize: 100,
      format: 'mp3',
      mimeType: 'audio/mpeg',
      deliveryUrl: 'https://cdn/x.mp3',
    });
    expect(detail).toEqual({ durationMs: 0 });
  });

  it('maps an asset to the public dto with files keyed by role', () => {
    const dto = AUDIO_DESCRIPTOR.toPublicDto({
      id: 'a1',
      slug: 'rise',
      kind: AssetKind.audio,
      title: 'Rise',
      authorName: 'SlimShot',
      downloadCount: 7,
      files: [
        {
          role: FileRole.preview,
          deliveryUrl: 'https://cdn/preview.mp3',
          byteSize: 812_340,
          format: 'mp3',
          durationMs: 145_200,
          width: null,
          height: null,
          variant: null,
        },
      ],
      audio: { durationMs: 145_200, bpm: 120, isLoopable: false },
    });

    expect(dto.files.preview.url).toBe('https://cdn/preview.mp3');
    expect(dto.detail).toEqual({ durationMs: 145_200, bpm: 120, isLoopable: false });
    expect(dto.stats.downloadCount).toBe(7);
  });

  it('omits a file whose delivery url is not yet known', () => {
    const dto = AUDIO_DESCRIPTOR.toPublicDto({
      id: 'a1',
      slug: 'rise',
      kind: AssetKind.audio,
      title: 'Rise',
      authorName: 'SlimShot',
      downloadCount: 0,
      files: [
        {
          role: FileRole.original,
          deliveryUrl: null,
          byteSize: 1,
          format: 'mp3',
          durationMs: null,
          width: null,
          height: null,
          variant: null,
        },
      ],
      audio: { durationMs: 1, bpm: null, isLoopable: false },
    });

    expect(dto.files.original).toBeUndefined();
  });

  it('never exposes the original download url in the public dto', () => {
    const dto = AUDIO_DESCRIPTOR.toPublicDto({
      id: 'a1',
      slug: 'rise',
      kind: AssetKind.audio,
      title: 'Rise',
      authorName: 'SlimShot',
      downloadCount: 0,
      files: [
        {
          role: FileRole.original,
          deliveryUrl: 'https://cdn/original.wav',
          byteSize: 1,
          format: 'wav',
          durationMs: null,
          width: null,
          height: null,
          variant: null,
        },
      ],
      audio: { durationMs: 1, bpm: null, isLoopable: false },
    });

    expect(JSON.stringify(dto)).not.toContain('original.wav');
  });
});
