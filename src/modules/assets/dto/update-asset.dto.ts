import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

export class UpdateAssetDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  authorName?: string;

  /** A category of the asset's kind; null removes it. */
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsString()
  categoryId?: string | null;
}
