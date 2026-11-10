import { Transform } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateVoiceDto {
  /** The name the app shows; trimmed, 1–40 characters. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  label?: string;

  /** Switched on only with a sample (the service refuses otherwise). */
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class ReorderVoicesDto {
  /** Every voice, once each, top to bottom. */
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  ids!: string[];
}
