import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { Session } from '../entities/session.entity';
import { SessionStatus } from '../entities/session.entity';
import type { ProxyType } from './update-proxy.dto';

/**
 * Non-secret view of a session's proxy config for the dashboard form. The password is intentionally
 * NOT included — only whether one is set (`hasPassword`) — so it never travels in an API response.
 */
export class SessionProxyDto {
  @ApiProperty({ enum: ['http', 'https', 'socks4', 'socks5'], example: 'socks5' })
  type: ProxyType;

  @ApiProperty({ example: '100.104.50.91' })
  host: string;

  @ApiProperty({ example: 1080 })
  port: number;

  @ApiPropertyOptional({ type: String, example: 'raspproxy8', nullable: true })
  username?: string | null;

  @ApiProperty({ example: true, description: 'Whether a password is stored (the value itself is never returned).' })
  hasPassword: boolean;
}

/**
 * Parse a stored `proxyUrl` into the non-secret fields the dashboard needs, or `null` when the URL is
 * absent/unparseable. The password is deliberately dropped. Exported for reuse/testing.
 */
export function parseProxyForResponse(proxyUrl?: string | null): SessionProxyDto | null {
  if (!proxyUrl) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    return null;
  }
  const type = parsed.protocol.replace(':', '') as ProxyType;
  const port = parsed.port ? parseInt(parsed.port, 10) : NaN;
  return {
    type,
    host: parsed.hostname,
    port: Number.isInteger(port) ? port : 0,
    username: parsed.username ? decodeURIComponent(parsed.username) : null,
    hasPassword: parsed.password !== '',
  };
}

export class SessionResponseDto {
  @ApiProperty({ example: 'sess_123e4567-e89b-12d3-a456-426614174000' })
  id: string;

  @ApiProperty({ example: 'my-bot' })
  name: string;

  @ApiProperty({ enum: SessionStatus, example: SessionStatus.READY })
  status: SessionStatus;

  @ApiPropertyOptional({ type: String, example: '628123456789', nullable: true })
  phone?: string | null;

  @ApiPropertyOptional({ type: String, example: 'John Doe', nullable: true })
  pushName?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', example: '2025-02-02T10:00:00Z', nullable: true })
  connectedAt?: Date | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', example: '2025-02-02T10:30:00Z', nullable: true })
  lastActive?: Date | null;

  @ApiProperty({ example: '2025-02-02T09:00:00Z' })
  createdAt: Date;

  @ApiProperty({ example: '2025-02-02T10:00:00Z' })
  updatedAt: Date;

  @ApiPropertyOptional({
    type: String,
    description: 'Human-readable reason for the most recent terminal engine failure (only set when status is FAILED).',
    example: 'Failed to launch the browser process: spawn /usr/bin/chromium ENOENT',
    nullable: true,
  })
  lastError?: string | null;

  @ApiPropertyOptional({
    type: SessionProxyDto,
    nullable: true,
    description: 'Per-session proxy configuration (password omitted). Null when no proxy is set.',
  })
  proxy?: SessionProxyDto | null;

  /**
   * Map a Session entity to the public response shape. The raw `config` blob and the proxy password
   * are stripped; the proxy's non-secret fields (type/host/port/username/hasPassword) are surfaced so
   * the dashboard can render and edit them.
   */
  static fromEntity(session: Session): SessionResponseDto {
    return {
      id: session.id,
      name: session.name,
      status: session.status,
      phone: session.phone,
      pushName: session.pushName,
      connectedAt: session.connectedAt,
      lastActive: session.lastActiveAt,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastError: session.lastError ?? null,
      proxy: parseProxyForResponse(session.proxyUrl),
    };
  }
}

export class QRCodeResponseDto {
  @ApiProperty({
    description: 'QR code as data URL',
    example: 'data:image/png;base64,...',
  })
  qrCode: string;

  @ApiProperty({ enum: SessionStatus, example: SessionStatus.QR_READY })
  status: SessionStatus;
}
