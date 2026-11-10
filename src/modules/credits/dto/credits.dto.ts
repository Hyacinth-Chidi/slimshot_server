import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';

import { CreditFeature } from '../../../generated/prisma/enums';

/**
 * What a job will cost: Auto captions by the audio's length, text to speech by
 * its characters (code points of the trimmed texts, summed — the server counts
 * again when the job starts and charges what it counts).
 */
export class QuoteDto {
  @IsEnum(CreditFeature)
  feature!: CreditFeature;

  @ValidateIf((o: QuoteDto) => o.feature === CreditFeature.auto_captions)
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(14_400)
  durationSeconds?: number;

  @ValidateIf((o: QuoteDto) => o.feature === CreditFeature.text_to_speech)
  @IsInt()
  @Min(1)
  @Max(20_000)
  characters?: number;
}

/** The amount a quote is priced by: seconds for Auto captions, characters for text to speech. */
export function quoteAmount(dto: QuoteDto): number {
  return dto.feature === CreditFeature.text_to_speech ? dto.characters! : dto.durationSeconds!;
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
