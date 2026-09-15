import { AssetKind, FileRole } from '../../../../generated/prisma/enums';
import { RemoteObject } from '../../../../core/storage/storage-adapter.interface';
import {
  AssetKindDescriptor,
  AssetWithRelations,
  PublicAsset,
  PublicAssetFile,
} from '../../asset-kind.interface';
import { AudioDetailDto } from './audio-detail.dto';

/** Roles safe to expose in a browse response. `original` is gated. */
const PUBLIC_ROLES: readonly FileRole[] = [
  FileRole.preview,
  FileRole.thumbnail,
  FileRole.waveform,
];

export const AUDIO_DESCRIPTOR: AssetKindDescriptor = {
  kind: AssetKind.audio,
  label: 'Audio',

  accepts: {
    mimeTypesSetting: 'upload.audio.mimeTypes',
    maxBytesSetting: 'upload.audio.maxBytes',
    extensions: ['.mp3', '.wav', '.aac', '.ogg', '.flac'],
  },

  fileRoles: [
    { role: FileRole.original, required: true, multiple: false },
    { role: FileRole.preview, required: false, multiple: false },
    { role: FileRole.waveform, required: false, multiple: false },
    { role: FileRole.thumbnail, required: false, multiple: false },
  ],

  detailDto: AudioDetailDto,

  processors: ['audio:preview', 'audio:waveform'],

  buildDetail(remote: RemoteObject): Record<string, unknown> {
    return { durationMs: remote.durationMs ?? 0 };
  },

  toPublicDto(asset: AssetWithRelations): PublicAsset {
    const files: Record<string, PublicAssetFile> = {};

    for (const file of asset.files) {
      if (!PUBLIC_ROLES.includes(file.role) || !file.deliveryUrl) continue;

      files[file.role] = {
        url: file.deliveryUrl,
        byteSize: file.byteSize,
        format: file.format,
        ...(file.durationMs !== null ? { durationMs: file.durationMs } : {}),
        ...(file.width !== null ? { width: file.width } : {}),
        ...(file.height !== null ? { height: file.height } : {}),
      };
    }

    return {
      id: asset.id,
      slug: asset.slug,
      kind: asset.kind,
      title: asset.title,
      author: asset.authorName,
      tags: [],
      files,
      detail: {
        durationMs: asset.audio?.durationMs ?? 0,
        bpm: asset.audio?.bpm ?? null,
        isLoopable: asset.audio?.isLoopable ?? false,
      },
      stats: { downloadCount: asset.downloadCount },
    };
  },
};
