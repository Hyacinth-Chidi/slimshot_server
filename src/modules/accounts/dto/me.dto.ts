import { Equals, IsOptional, IsString, MaxLength } from 'class-validator';

export class UsernameDto {
  @IsString()
  @MaxLength(40)
  username!: string;
}

export class ClaimDto extends UsernameDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  referralCode?: string;
}

export class DeleteMeDto {
  @Equals('DELETE', { message: 'Send {"confirm":"DELETE"} to delete the account.' })
  confirm!: 'DELETE';
}
