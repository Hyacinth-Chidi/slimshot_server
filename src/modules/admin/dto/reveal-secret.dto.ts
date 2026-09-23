import { IsString, MinLength } from 'class-validator';

export class RevealSecretDto {
  @IsString()
  @MinLength(8)
  password!: string;
}
