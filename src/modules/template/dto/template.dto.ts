import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, MaxLength, IsIn, IsBoolean, ValidateIf } from 'class-validator';

const NAME_MAX_LENGTH = 100;
const BODY_MAX_LENGTH = 4096;
const HEADER_FOOTER_MAX_LENGTH = 1024;
const FILENAME_MAX_LENGTH = 255;

export const TEMPLATE_MEDIA_TYPES = ['image', 'video', 'document', 'audio'] as const;
export type TemplateMediaType = (typeof TEMPLATE_MEDIA_TYPES)[number];

export class CreateTemplateDto {
  @ApiProperty({
    description: 'Unique template name within the session',
    example: 'order-confirmation',
    maxLength: NAME_MAX_LENGTH,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(NAME_MAX_LENGTH)
  name: string;

  @ApiPropertyOptional({
    description:
      'Template body with {{variable}} placeholders. Required for a text template; optional when a ' +
      'media attachment is provided (the body then renders as the media caption, and may be empty). ' +
      'The "body required unless media is attached" rule is enforced by the service.',
    example: 'Hi {{customer}}, your order {{orderId}} has shipped.',
    maxLength: BODY_MAX_LENGTH,
  })
  // Shape-only validation here (optional, string, bounded). The cross-field requirement — a text
  // template MUST have a non-empty body, a media template need not — is enforced in TemplateService,
  // where both fields are known, rather than via brittle stacked @ValidateIf conditions.
  @IsOptional()
  @IsString()
  @MaxLength(BODY_MAX_LENGTH)
  body?: string;

  @ApiPropertyOptional({
    description: 'Optional header text, prepended to the rendered body',
    example: 'OpenWA Store',
    maxLength: HEADER_FOOTER_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(HEADER_FOOTER_MAX_LENGTH)
  header?: string;

  @ApiPropertyOptional({
    description: 'Optional footer text, appended to the rendered body',
    example: 'Reply STOP to unsubscribe.',
    maxLength: HEADER_FOOTER_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(HEADER_FOOTER_MAX_LENGTH)
  footer?: string;

  @ApiPropertyOptional({
    description:
      'Attach a single media file to the template. When set, the template is sent as this media type ' +
      'with the rendered text as its caption. Requires mediaBase64 and mimetype.',
    enum: TEMPLATE_MEDIA_TYPES,
    example: 'image',
  })
  @IsOptional()
  @IsIn(TEMPLATE_MEDIA_TYPES)
  mediaType?: TemplateMediaType;

  @ApiPropertyOptional({
    description: 'Base64-encoded media bytes (data: URI prefix accepted). Required when mediaType is set.',
  })
  @ValidateIf((o: CreateTemplateDto) => o.mediaType != null)
  @IsString()
  @IsNotEmpty()
  mediaBase64?: string;

  @ApiPropertyOptional({
    description: 'MIME type of the attached media. Required when mediaType is set.',
    example: 'image/jpeg',
  })
  @ValidateIf((o: CreateTemplateDto) => o.mediaType != null)
  @IsString()
  @IsNotEmpty()
  @MaxLength(FILENAME_MAX_LENGTH)
  mimetype?: string;

  @ApiPropertyOptional({
    description: 'Optional filename for the attached media',
    example: 'promo.jpg',
    maxLength: FILENAME_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(FILENAME_MAX_LENGTH)
  filename?: string;
}

export class UpdateTemplateDto {
  @ApiPropertyOptional({ description: 'Template name', maxLength: NAME_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(NAME_MAX_LENGTH)
  name?: string;

  @ApiPropertyOptional({ description: 'Template body with {{variable}} placeholders', maxLength: BODY_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(BODY_MAX_LENGTH)
  body?: string;

  @ApiPropertyOptional({ description: 'Optional header text', maxLength: HEADER_FOOTER_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(HEADER_FOOTER_MAX_LENGTH)
  header?: string;

  @ApiPropertyOptional({ description: 'Optional footer text', maxLength: HEADER_FOOTER_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(HEADER_FOOTER_MAX_LENGTH)
  footer?: string;

  @ApiPropertyOptional({
    description:
      'Replace the media attachment. Pass mediaType=null (with removeMedia) to clear it, or a new ' +
      'mediaType + mediaBase64 + mimetype to swap it. Omit these fields to leave the media unchanged.',
    enum: TEMPLATE_MEDIA_TYPES,
    example: 'video',
  })
  @IsOptional()
  @IsIn(TEMPLATE_MEDIA_TYPES)
  mediaType?: TemplateMediaType;

  @ApiPropertyOptional({ description: 'Base64-encoded media bytes. Required when replacing media (mediaType set).' })
  @ValidateIf((o: UpdateTemplateDto) => o.mediaType != null)
  @IsString()
  @IsNotEmpty()
  mediaBase64?: string;

  @ApiPropertyOptional({
    description: 'MIME type of the attached media. Required when replacing media.',
    example: 'video/mp4',
  })
  @ValidateIf((o: UpdateTemplateDto) => o.mediaType != null)
  @IsString()
  @IsNotEmpty()
  @MaxLength(FILENAME_MAX_LENGTH)
  mimetype?: string;

  @ApiPropertyOptional({ description: 'Optional filename for the attached media', maxLength: FILENAME_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(FILENAME_MAX_LENGTH)
  filename?: string;

  @ApiPropertyOptional({
    description: 'Set true to remove the existing media attachment (turning the template back into text-only).',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  removeMedia?: boolean;
}

export class TemplateResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  sessionId: string;

  @ApiProperty()
  name: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  body?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  header?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  footer?: string | null;

  @ApiProperty({ description: 'True when the template carries a media attachment.' })
  hasMedia: boolean;

  @ApiPropertyOptional({ enum: TEMPLATE_MEDIA_TYPES, nullable: true })
  mediaType?: TemplateMediaType | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  mimetype?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  filename?: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
