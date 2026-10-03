import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import { CreditFeature } from '../../../generated/prisma/enums';

export class QuoteDto {
  @IsEnum(CreditFeature)
  feature!: CreditFeature;

  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(14_400)
  durationSeconds!: number;
}

export class HistoryQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
