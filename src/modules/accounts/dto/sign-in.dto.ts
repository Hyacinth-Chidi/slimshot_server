import { Transform, TransformFnParams } from 'class-transformer';
import { IsEmail, IsString, Length, Matches, MaxLength } from 'class-validator';

const lower = ({ value }: TransformFnParams): unknown => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export class DeviceBoundDto {
  @IsString()
  @Length(20, 200)
  deviceToken!: string;
}

export class GoogleSignInDto extends DeviceBoundDto {
  @IsString()
  @Length(20, 4096)
  idToken!: string;
}

export class EmailStartDto extends DeviceBoundDto {
  @Transform(lower)
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class EmailVerifyDto extends EmailStartDto {
  @Matches(/^\d{6}$/, { message: 'code must be the 6 digits from the email' })
  code!: string;
}

export class AppRefreshDto {
  @IsString()
  @Length(20, 200)
  refreshToken!: string;
}
