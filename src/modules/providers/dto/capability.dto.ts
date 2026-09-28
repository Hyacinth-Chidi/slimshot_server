import { IsEnum } from 'class-validator';

import { ProviderCapability } from '../../../generated/prisma/enums';

export class CapabilityDto {
  @IsEnum(ProviderCapability)
  capability!: ProviderCapability;
}
