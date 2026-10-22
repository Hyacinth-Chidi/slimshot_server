import { ArrayNotEmpty, IsArray, IsDefined, IsString, MaxLength, ValidateIf } from 'class-validator';

export class ReorderFontsDto {
  /** Every published font, once each, top to bottom. */
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  ids!: string[];
}

export class UpdateFontDto {
  /** The licence note, for the owner's records; null clears it. */
  @IsDefined({ message: 'license is required (null clears it)' })
  @ValidateIf((_o, value) => value !== null)
  @IsString()
  @MaxLength(500)
  license!: string | null;
}
