import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export type ProxyType = 'http' | 'https' | 'socks4' | 'socks5';

/**
 * Per-session proxy configuration, supplied as structured fields so the dashboard can present
 * separate inputs. The service assembles these into the stored `proxyUrl`. Sending an empty/omitted
 * `host` clears the proxy for the session.
 *
 * Note: for a SOCKS proxy with credentials, OpenWA runs an in-process authenticating relay so the
 * whatsapp-web.js (Chromium) engine — which cannot authenticate SOCKS itself — can still egress
 * through it. See {@link ProxyRelayService}.
 */
export class UpdateProxyDto {
  @ApiPropertyOptional({
    description: 'Proxy scheme. Required when host is set.',
    enum: ['http', 'https', 'socks4', 'socks5'],
    example: 'socks5',
  })
  @IsOptional()
  @IsIn(['http', 'https', 'socks4', 'socks5'])
  type?: ProxyType;

  @ApiPropertyOptional({
    description: 'Proxy host or IP (e.g. a Tailscale IP). Leave empty to remove the proxy.',
    example: '100.104.50.91',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  host?: string;

  @ApiPropertyOptional({ description: 'Proxy port.', example: 1080, minimum: 1, maximum: 65535 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @ApiPropertyOptional({ description: 'Proxy username (optional).', example: 'raspproxy8' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  username?: string;

  @ApiPropertyOptional({
    description:
      'Proxy password (optional). Omit to keep the currently stored password when only editing other ' +
      'fields; send an empty string to clear it.',
    example: 's3cr3t',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  password?: string;
}
