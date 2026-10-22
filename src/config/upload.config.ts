import { ConfigType, registerAs } from '@nestjs/config';

import { AssetKind } from '../generated/prisma/enums';
import { parseEnv } from './env.validation';

export interface UploadLimits {
  maxBytes: number;
  mimeTypes: string[];
}

export const uploadConfig = registerAs('upload', () => {
  const env = parseEnv(process.env);
  // Only kinds with limits here can be uploaded.
  const limits: Partial<Record<AssetKind, UploadLimits>> = {
    [AssetKind.audio]: {
      maxBytes: env.UPLOAD_AUDIO_MAX_BYTES,
      mimeTypes: env.UPLOAD_AUDIO_MIME_TYPES,
    },
    [AssetKind.font]: {
      maxBytes: env.UPLOAD_FONT_MAX_BYTES,
      mimeTypes: ['font/ttf', 'font/otf'],
    },
  };
  // Covers belong to a sound of any kind, so they are not keyed by kind.
  const cover: UploadLimits = {
    maxBytes: env.UPLOAD_COVER_MAX_BYTES,
    mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  };
  return { ticketTtlSeconds: env.UPLOAD_TICKET_TTL_SECONDS, limits, cover };
});

export type UploadConfig = ConfigType<typeof uploadConfig>;
