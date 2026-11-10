import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsNotEmpty, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';

import { ITEM_ID } from '../speech.constants';

export class SpeechItemDto {
  /** The app's own id for the text; the voice is downloaded under it. */
  @IsString()
  @Matches(ITEM_ID, { message: 'id must be 1–64 letters, digits, "-" or "_"' })
  id!: string;

  /** Trimmed by the server; its length is checked there, in characters (code points). */
  @IsString()
  text!: string;
}

/** The shape only. How many texts and characters a request may hold is the service's (TTS_MAX_*). */
export class StartSpeechDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  voiceId!: string;

  @IsArray()
  @ArrayMinSize(1)
  // TTS_MAX_ITEMS' own ceiling: the service holds the configured limit.
  @ArrayMaxSize(1_000)
  @ValidateNested({ each: true })
  @Type(() => SpeechItemDto)
  items!: SpeechItemDto[];
}
