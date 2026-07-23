import * as net from 'net';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { createLogger } from '../../common/services/logger.service';

/**
 * Parsed pieces of a SOCKS5 upstream that needs an authenticating relay.
 */
interface RelayUpstream {
  host: string;
  port: number;
  username: string;
  password: string;
}

interface ActiveRelay {
  server: net.Server;
  /** The loopback URL Chromium should point at (no credentials). */
  localUrl: string;
}

/**
 * Chromium (the whatsapp-web.js engine) cannot authenticate SOCKS proxies — `--proxy-server`
 * ignores embedded credentials and there is no SOCKS equivalent of `page.authenticate`. A residential
 * proxy fronted by microsocks (which requires user/password) is therefore unreachable by the browser
 * directly.
 *
 * This service bridges that gap in-process: for a credentialed SOCKS5 upstream it opens a tiny loopback
 * SOCKS5 server that accepts NO authentication locally and forwards each connection to the real proxy
 * WITH the stored credentials. Chromium points at `socks5://127.0.0.1:<port>` and egresses through the
 * residential IP without ever needing to speak SOCKS auth.
 *
 * One relay is kept per distinct upstream URL for the lifetime of the process (a handful at most, one
 * idle listener each), shared by every session that uses the same proxy. Non-SOCKS proxies, and SOCKS
 * proxies without credentials, need no relay and are returned unchanged.
 */
@Injectable()
export class ProxyRelayService implements OnModuleDestroy {
  private readonly logger = createLogger('ProxyRelayService');
  /** Keyed by the exact upstream proxyUrl so identical configs share one listener. */
  private readonly relays = new Map<string, ActiveRelay>();

  /**
   * Translate a session's configured proxy URL into the URL the engine should actually use.
   * For a credentialed SOCKS5 upstream this is a loopback relay URL; for everything else the input
   * is returned unchanged (Chromium handles HTTP/HTTPS auth itself, and credential-less SOCKS works
   * directly). Returns `undefined` for no proxy.
   */
  async resolveEngineProxyUrl(proxyUrl?: string | null): Promise<string | undefined> {
    if (!proxyUrl) {
      return undefined;
    }
    const upstream = parseRelayUpstream(proxyUrl);
    if (!upstream) {
      // Not a credentialed SOCKS5 proxy — no relay needed, pass through as-is.
      return proxyUrl;
    }

    const existing = this.relays.get(proxyUrl);
    if (existing) {
      return existing.localUrl;
    }

    const relay = await this.createRelay(upstream);
    this.relays.set(proxyUrl, relay);
    this.logger.log(`Proxy relay ready on ${relay.localUrl} -> ${upstream.host}:${upstream.port}`, {
      action: 'proxy_relay_started',
      upstreamHost: upstream.host,
      upstreamPort: upstream.port,
    });
    return relay.localUrl;
  }

  private createRelay(upstream: RelayUpstream): Promise<ActiveRelay> {
    return new Promise((resolve, reject) => {
      const server = net.createServer(client => this.handleClient(client, upstream));
      server.on('error', err => {
        // A listen error before resolve rejects; a later runtime error is logged, not fatal.
        this.logger.error('Proxy relay server error', err instanceof Error ? err.message : String(err), {
          action: 'proxy_relay_error',
        });
      });
      // Port 0 → OS assigns a free ephemeral port; bind to loopback only so the no-auth relay is
      // never reachable off-box.
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr === null || typeof addr === 'string') {
          server.close();
          reject(new Error('Proxy relay failed to bind a loopback port'));
          return;
        }
        resolve({ server, localUrl: `socks5://127.0.0.1:${addr.port}` });
      });
    });
  }

  /**
   * Minimal SOCKS5 relay for one client connection:
   *  1. Answer the client's greeting selecting "no authentication".
   *  2. Read the client's CONNECT request and forward it verbatim to the upstream, after
   *     authenticating to the upstream with username/password.
   *  3. Once authenticated, pipe both directions transparently.
   */
  private handleClient(client: net.Socket, upstream: RelayUpstream): void {
    client.on('error', () => client.destroy());

    client.once('data', (greeting: Buffer) => {
      // greeting: [VER=0x05, NMETHODS, METHODS...]
      if (greeting[0] !== 0x05) {
        client.destroy();
        return;
      }
      // Reply: version 5, method 0x00 (no auth) — the local side is loopback-only.
      client.write(Buffer.from([0x05, 0x00]));
      client.once('data', (request: Buffer) => this.connectUpstream(client, request, upstream));
    });
  }

  private connectUpstream(client: net.Socket, request: Buffer, upstream: RelayUpstream): void {
    const up = net.connect(upstream.port, upstream.host, () => {
      // Offer username/password (0x02) and, defensively, no-auth (0x00).
      up.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
    });

    const fail = (): void => {
      client.destroy();
      up.destroy();
    };
    up.on('error', fail);
    client.on('error', fail);
    up.on('close', () => client.destroy());
    client.on('close', () => up.destroy());

    let stage: 'method' | 'auth' | 'pipe' = 'method';
    const onData = (data: Buffer): void => {
      if (stage === 'method') {
        if (data[0] !== 0x05) {
          fail();
          return;
        }
        if (data[1] === 0x02) {
          const u = Buffer.from(upstream.username);
          const p = Buffer.from(upstream.password);
          up.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
          stage = 'auth';
        } else if (data[1] === 0x00) {
          goTransparent();
        } else {
          fail(); // upstream demanded an auth method we do not implement
        }
      } else if (stage === 'auth') {
        // Auth reply: [VER=0x01, STATUS] — 0x00 means success.
        if (data[0] !== 0x01 || data[1] !== 0x00) {
          fail();
          return;
        }
        goTransparent();
      }
    };
    up.on('data', onData);

    const goTransparent = (): void => {
      up.removeListener('data', onData);
      up.pipe(client);
      client.pipe(up);
      // Forward the client's original CONNECT request; the upstream's reply flows back through the pipe.
      up.write(request);
      stage = 'pipe';
    };
  }

  onModuleDestroy(): void {
    for (const [, relay] of this.relays) {
      relay.server.close();
    }
    this.relays.clear();
  }
}

/**
 * Parse a proxy URL into the pieces needed for an authenticating SOCKS5 relay, or return `null` when
 * no relay is needed (non-SOCKS5 scheme, or SOCKS5 without credentials). Exported for testing.
 */
export function parseRelayUpstream(proxyUrl: string): RelayUpstream | null {
  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'socks5:') {
    return null;
  }
  const username = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  if (username === '' && password === '') {
    return null; // credential-less SOCKS5 works in Chromium directly
  }
  const port = parsed.port ? parseInt(parsed.port, 10) : 1080;
  if (!parsed.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  return { host: parsed.hostname, port, username, password };
}
