import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, NotEquals } from 'class-validator';

export class PageQueryDto {
  @IsOptional() @IsString() @MaxLength(200) cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class SearchUsersQueryDto extends PageQueryDto {
  /** Part of an email address or username. */
  @IsOptional() @IsString() @MaxLength(200) q?: string;
}

export class ReasonDto {
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

export class AdjustCreditsDto extends ReasonDto {
  /** Positive grants, negative takes away. */
  @IsInt() @NotEquals(0) @Min(-1_000_000) @Max(1_000_000) amount!: number;
}

export class CreditStatsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days: number = 30;
}
