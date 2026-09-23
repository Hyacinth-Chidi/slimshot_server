import { IsDefined, IsOptional, IsString, MinLength } from 'class-validator';

export class UpdateSettingDto {
  @IsDefined()
  value!: unknown;

  /** Either a fresh password or a grant from a prior reveal. Neither is needed for a non-secret setting. */
  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;

  @IsOptional()
  @IsString()
  grant?: string;
}
