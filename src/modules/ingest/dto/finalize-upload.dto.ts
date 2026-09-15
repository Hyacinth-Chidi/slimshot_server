import { IsString } from 'class-validator';

export class FinalizeUploadDto {
  @IsString()
  sessionId!: string;
}
