import { Transform, TransformFnParams, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsFQDN,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { CreditFeature, PricingMode } from '../../../generated/prisma/enums';

/** Trimmed, lowercased and de-duplicated, so the stored list matches how emails are compared. */
const domainList = ({ value }: TransformFnParams): unknown =>
  Array.isArray(value)
    ? [...new Set(value.map((d: unknown) => (typeof d === 'string' ? d.trim().toLowerCase() : d)))]
    : value;

export class UpdateCreditSettingsDto {
  @IsOptional() @IsInt() @Min(0) @Max(100_000) signupBonusCredits?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100_000) adRewardCredits?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1_000) adDailyCap?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100_000) referralInviterCredits?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100_000) referralInviteeCredits?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10_000) referralCapCount?: number;
  @IsOptional() @IsInt() @Min(1) @Max(365) referralCapDays?: number;
  @IsOptional() @IsInt() @Min(1) @Max(100_000) ipSignupLimitPer24h?: number;
  @IsOptional() @IsInt() @Min(1) @Max(20) otpMaxAttempts?: number;
  @IsOptional() @IsInt() @Min(0) @Max(3_600) otpResendCooldownSeconds?: number;
  @IsOptional() @IsInt() @Min(1) @Max(10_000) otpPerEmailPerHour?: number;
  @IsOptional() @IsInt() @Min(1) @Max(10_000) otpPerDevicePerHour?: number;
  @IsOptional() @IsInt() @Min(1) @Max(10_000) otpPerIpPerHour?: number;

  @IsOptional()
  @Transform(domainList)
  @IsArray()
  @ArrayMaxSize(5_000)
  @IsFQDN({}, { each: true })
  disposableEmailDomains?: string[];
}

export class PriceTierDto {
  /** Inclusive upper bound in seconds; `null` only on the last, open-ended tier. */
  @ValidateIf((tier: PriceTierDto) => tier.upToSeconds !== null)
  @IsInt()
  @Min(1)
  @Max(86_400)
  upToSeconds!: number | null;

  @IsInt() @Min(0) @Max(100_000) credits!: number;
}

export class CreatePricingRuleDto {
  @IsEnum(CreditFeature) feature!: CreditFeature;
  @IsEnum(PricingMode) mode!: PricingMode;

  @IsOptional() @IsInt() @Min(0) @Max(100_000) perJobCredits?: number;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PriceTierDto)
  tiers?: PriceTierDto[];

  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class PricingRulesQueryDto {
  @IsEnum(CreditFeature) feature!: CreditFeature;
}
