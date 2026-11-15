import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'agent-a@example.com' })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ example: 'local_dev_seed_password' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;

  @ApiProperty({ example: 'tenant-a', description: '租户编码，决定登录后签发的会话归属' })
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{1,31}$/)
  tenantCode!: string;
}
