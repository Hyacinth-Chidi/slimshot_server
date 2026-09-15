import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';

import { AssetKind } from '../../../generated/prisma/enums';

export class CreateUploadTicketDto {
  @IsEnum(AssetKind)
  kind!: AssetKind;

  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  filename!: string;

  @IsString()
  mimeType!: string;

  @IsInt()
  @Min(1)
  byteSize!: number;

  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  title?: string;

  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  author?: string;
}
