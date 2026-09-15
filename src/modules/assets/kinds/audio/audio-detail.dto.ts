import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class AudioDetailDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  bpm?: number;

  @IsOptional()
  @IsString()
  musicalKey?: string;

  @IsOptional()
  @IsBoolean()
  isLoopable?: boolean;
}
