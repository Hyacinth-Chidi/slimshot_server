import { Transform } from 'class-transformer';
import { IsString, Length, Matches } from 'class-validator';

import { CapabilityDto } from './capability.dto';

export class SetProviderKeyDto extends CapabilityDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(8, 512)
  @Matches(/^\S+$/, { message: 'apiKey must not contain spaces or line breaks' })
  apiKey!: string;
}
