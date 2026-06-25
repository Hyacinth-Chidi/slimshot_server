import { Transform } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

import type { AudioType } from '../../../common/interfaces/audio-track.interface';

export class CreateAudioUploadSignatureDto {
  @IsString()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  originalFilename!: string;

  @IsOptional()
  @IsString()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  mimeType?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  fileSizeBytes?: number;

  @IsOptional()
  @IsString()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  title?: string;

  @IsOptional()
  @IsString()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  author?: string;

  @IsOptional()
  @IsIn(['music', 'sfx'])
  type: AudioType = 'music';

  @IsOptional()
  @Transform(({ value }) => {
    if (Array.isArray(value)) {
      return value
        .flatMap((entry) =>
          typeof entry === 'string' ? entry.split(',') : [],
        )
        .map((entry) => entry.trim())
        .filter(Boolean);
    }

    if (typeof value === 'string') {
      return value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
    }

    return [];
  })
  @IsArray()
  @IsString({ each: true })
  tags: string[] = [];
}
