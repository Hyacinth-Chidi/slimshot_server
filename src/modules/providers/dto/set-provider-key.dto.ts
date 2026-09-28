import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';

import { CapabilityDto } from './capability.dto';

export class SetProviderKeyDto extends CapabilityDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(8, 512)
  apiKey!: string;
}
