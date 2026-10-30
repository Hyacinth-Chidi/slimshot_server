import { IsNotEmpty, IsString, MaxLength, ValidateIf } from 'class-validator';

export class PushTokenDto {
  /** The install's token from POST /devices. */
  @IsString() @IsNotEmpty() @MaxLength(512) deviceToken!: string;
  /** The Firebase Cloud Messaging token, or null when the user turns notifications off. */
  @ValidateIf((o: PushTokenDto) => o.token !== null)
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  token!: string | null;
}
