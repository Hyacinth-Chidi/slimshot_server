import { Type } from '@nestjs/common';

import { AssetKind, FileRole } from '../../generated/prisma/enums';
import { RemoteObject } from '../../core/storage/storage-adapter.interface';

export interface KindFileRole {
  role: FileRole;
  required: boolean;
  multiple: boolean;
}

export interface KindAccepts {
  mimeTypesSetting: string;
  maxBytesSetting: string;
  extensions: string[];
}

export interface PublicAssetFile {
  url: string;
  byteSize: number;
  format: string;
  durationMs?: number;
  width?: number;
  height?: number;
  variant?: Record<string, unknown>;
}

export interface PublicAsset {
  id: string;
  slug: string;
  kind: AssetKind;
  title: string;
  author: string;
  tags: string[];
  files: Record<string, PublicAssetFile>;
  detail: Record<string, unknown>;
  stats: { downloadCount: number };
}

/** The shape the generic asset service hands to a descriptor. */
export interface AssetWithRelations {
  id: string;
  slug: string;
  kind: AssetKind;
  title: string;
  authorName: string;
  downloadCount: number;
  files: Array<{
    role: FileRole;
    deliveryUrl: string | null;
    byteSize: number;
    format: string;
    durationMs: number | null;
    width: number | null;
    height: number | null;
    variant: unknown;
  }>;
  audio?: { durationMs: number; bpm: number | null; isLoopable: boolean } | null;
}

export interface AssetKindDescriptor {
  kind: AssetKind;
  label: string;
  accepts: KindAccepts;
  fileRoles: KindFileRole[];
  detailDto: Type<unknown>;
  processors: string[];
  /** Typed detail row written at finalize, from provider-verified metadata. */
  buildDetail(remote: RemoteObject): Record<string, unknown>;
  toPublicDto(asset: AssetWithRelations): PublicAsset;
}

export const ASSET_KIND_DESCRIPTOR = Symbol('ASSET_KIND_DESCRIPTOR');
