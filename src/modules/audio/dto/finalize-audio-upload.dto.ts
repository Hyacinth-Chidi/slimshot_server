import { Transform } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Min,
} from 'class-validator';

import type { AudioType } from '../../../common/interfaces/audio-track.interface';

export class FinalizeAudioUploadDto {
  @IsString()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  publicId!: string;

  @IsOptional()
  @IsString()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  assetId?: string;

  @IsString()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  originalFilename!: string;

  @IsString()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  title!: string;

  @IsString()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  author!: string;

  @IsInt()
  @Min(0)
  durationSeconds!: number;

  @IsUrl({
    require_tld: false,
  })
  previewUrl!: string;

  @IsUrl({
    require_tld: false,
  })
  downloadUrl!: string;

  @IsIn(['music', 'sfx'])
  type!: AudioType;

  @IsArray()
  @IsString({ each: true })
  tags!: string[];

  @IsString()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  mimeType!: string;

  @IsInt()
  @Min(1)
  fileSizeBytes!: number;
}
