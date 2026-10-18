import { ConfigType, registerAs } from '@nestjs/config';

import { AssetKind } from '../generated/prisma/enums';
import { parseEnv } from './env.validation';

export interface UploadLimits {
  maxBytes: number;
  mimeTypes: string[];
}

export const uploadConfig = registerAs('upload', () => {
  const env = parseEnv(process.env);
  // Only kinds with limits here can be uploaded; audio is the only kind today.
  const limits: Partial<Record<AssetKind, UploadLimits>> = {
    [AssetKind.audio]: {
      maxBytes: env.UPLOAD_AUDIO_MAX_BYTES,
      mimeTypes: env.UPLOAD_AUDIO_MIME_TYPES,
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
