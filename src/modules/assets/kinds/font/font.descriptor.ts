import { AssetKind, FileRole } from '../../../../generated/prisma/enums';
import {
  AssetKindDescriptor,
  AssetWithRelations,
  PublicAsset,
  PublicAssetFile,
} from '../../asset-kind.interface';

/** A font's typed detail is managed by FontsService (names come from the file, not a form). */
export class FontDetailDto {}

/** Roles safe to expose in a browse response. The font file itself goes out only through download. */
const PUBLIC_ROLES: readonly FileRole[] = [FileRole.specimen];

/** One font face per asset: the TTF or OTF file, and its preview tile. */
export const FONT_DESCRIPTOR: AssetKindDescriptor = {
  kind: AssetKind.font,
  label: 'Fonts',

  accepts: {
    extensions: ['.ttf', '.otf'],
  },

  fileRoles: [
    { role: FileRole.original, required: true, multiple: false },
    { role: FileRole.specimen, required: false, multiple: false },
  ],

  detailDto: FontDetailDto,

  processors: [],

  buildDetail(): Record<string, unknown> {
    return {};
  },

  toPublicDto(asset: AssetWithRelations): PublicAsset {
    const files: Record<string, PublicAssetFile> = {};
    for (const file of asset.files) {
      if (!PUBLIC_ROLES.includes(file.role) || !file.deliveryUrl) continue;
      files[file.role] = {
        url: file.deliveryUrl,
        byteSize: file.byteSize,
        format: file.format,
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
      detail: {},
      stats: { downloadCount: asset.downloadCount },
    };
  },
};
