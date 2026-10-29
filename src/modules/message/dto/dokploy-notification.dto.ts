import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, TransformFnParams } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, IsUrl, IsUUID, Matches, MaxLength } from 'class-validator';

// Read the original JSON value so implicit conversion cannot turn objects or booleans into text.
const ToStrictString = () => Transform(({ obj, key }: TransformFnParams) => (obj as Record<string, unknown>)[key]);

export class DokployNotificationTargetDto {
  @IsUUID()
  sessionId!: string;

  @IsString()
  @MaxLength(255)
  @Matches(/^\d+(?:-\d+)?@g\.us$/, { message: 'chatId must be a WhatsApp group ID ending in @g.us' })
  chatId!: string;
}

export class DokployNotificationDto {
  @ApiProperty({ example: 'Build Error', maxLength: 256 })
  @ToStrictString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  title!: string;

  @ApiProperty({ example: 'Build failed with errors', maxLength: 4096 })
  @ToStrictString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  message!: string;

  @ApiPropertyOptional({ maxLength: 256 })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxLength(256)
  projectName?: string;

  @ApiPropertyOptional({ maxLength: 256 })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxLength(256)
  applicationName?: string;

  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxLength(64)
  applicationType?: string;

  @ApiPropertyOptional({ maxLength: 65536 })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxLength(65536)
  errorMessage?: string;

  @ApiPropertyOptional({ example: 'https://dokploy.example.com/dashboard/build/123', maxLength: 2048 })
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true, require_tld: false })
  @MaxLength(2048)
  buildLink?: string;

  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxLength(64)
  timestamp?: string;

  @ApiPropertyOptional({ maxLength: 128 })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxLength(128)
  date?: string;

  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxLength(64)
  status?: string;

  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxLength(64)
  type?: string;
}
