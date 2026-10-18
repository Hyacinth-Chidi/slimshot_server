import { Transform } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsOptional, IsString, Min, ValidateIf } from 'class-validator';

import { AssetKind, FileRole } from '../../../generated/prisma/enums';

export class CreateUploadTicketDto {
  /** `thumbnail` uploads a cover for an existing asset (`assetId`); default `original` creates a new asset. */
  @IsOptional()
  @IsIn([FileRole.original, FileRole.thumbnail])
  role?: FileRole;

  @ValidateIf((o: CreateUploadTicketDto) => o.role === FileRole.thumbnail)
  @IsString()
  assetId?: string;

  @ValidateIf((o: CreateUploadTicketDto) => o.role !== FileRole.thumbnail)
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

  /** Files the new asset under this category (one of its kind). */
  @IsOptional()
  @IsString()
  categoryId?: string;
}
