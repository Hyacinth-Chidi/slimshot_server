import { Transform } from 'class-transformer';
import { IsOptional, Matches } from 'class-validator';

export class StartCaptionDto {
  // Multipart text fields arrive as strings; blank means "detect it".
  @Transform(({ value }) =>
    typeof value === 'string' ? (value.trim() === '' ? undefined : value.trim().toLowerCase()) : value,
  )
  @IsOptional()
  @Matches(/^[a-z]{2}$/, { message: 'language must be a two-letter ISO 639-1 code such as en, fr or yo' })
  language?: string;
}
