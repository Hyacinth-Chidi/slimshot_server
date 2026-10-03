import { Transform, TransformFnParams } from 'class-transformer';
import { IsEmail, Matches, MaxLength } from 'class-validator';

const lower = ({ value }: TransformFnParams): unknown => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export class DeletionStartDto {
  @Transform(lower)
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class DeletionConfirmDto extends DeletionStartDto {
  @Matches(/^\d{6}$/, { message: 'code must be the 6 digits from the email' })
  code!: string;
}
