import { Transform, TransformFnParams } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

const trim = ({ value }: TransformFnParams): unknown => (typeof value === 'string' ? value.trim() : value);

export class SendPushDto {
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(100) title!: string;
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(1000) body!: string;
  /** One user, by id, email or username. Left out: every install. */
  @Transform(trim) @IsOptional() @IsString() @IsNotEmpty() @MaxLength(320) user?: string;
}
