import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

import { AssetKind } from '../../../generated/prisma/enums';

export class CatalogCategoriesQueryDto {
  @IsEnum(AssetKind)
  kind!: AssetKind;

  /** The slug of the top-level category whose children the app shows, e.g. `sound-effects`. */
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  root!: string;
}

export class CatalogAssetsQueryDto {
  @IsEnum(AssetKind)
  kind!: AssetKind;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 30;
}
