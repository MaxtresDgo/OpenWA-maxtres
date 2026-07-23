import * as http from 'http';
import * as https from 'https';
import { ProxyAgent } from 'proxy-agent';

/** Endpoint that echoes the caller's public IP as plain text. */
const EGRESS_PROBE_URL = 'https://api.ipify.org';
const DEFAULT_TIMEOUT_MS = 15000;

export interface EgressResult {
  ip: string;
}

export interface FetchEgressOptions {
  timeoutMs?: number;
  /** Override the probe endpoint (testing only); defaults to a public IP-echo service. */
  probeUrl?: string;
}

/**
 * Fetch the public egress IP as seen by an external endpoint, optionally routed through a proxy.
 *
 * Unlike Chromium, Node CAN authenticate a SOCKS5 proxy, so this hits the real upstream proxy URL
 * (credentials and all) directly via `proxy-agent`. The exit IP observed here is the same one a
 * whatsapp-web.js session gets through the loopback relay — both traverse the same microsocks to the
 * same residential line — so it is a faithful check of "does this proxy work and where does it exit".
 *
 * @param proxyUrl  Proxy to route through (http/https/socks4/socks5, credentials allowed). When
 *                  omitted, the request goes out directly so callers can compare against the box's own IP.
 */
export async function fetchEgressIp(proxyUrl?: string, options: FetchEgressOptions = {}): Promise<EgressResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const probeUrl = options.probeUrl ?? EGRESS_PROBE_URL;
  const get = probeUrl.startsWith('http://') ? http.get : https.get;
  const agent = proxyUrl ? new ProxyAgent({ getProxyForUrl: () => proxyUrl }) : undefined;
  try {
    const ip = await new Promise<string>((resolve, reject) => {
      // Single-settle guard: the response's 'data'/'end' and the request's 'timeout'/'error' can race,
      // so the first to fire wins and the rest become no-ops (destroy() below cannot re-resolve).
      let settled = false;
      const done = (fn: () => void): void => {
        if (!settled) {
          settled = true;
          fn();
        }
      };
      const req = get(probeUrl, { agent, timeout: timeoutMs }, res => {
        if (res.statusCode !== 200) {
          res.resume();
          done(() => reject(new Error(`Egress probe returned HTTP ${res.statusCode}`)));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          body += chunk;
          // Guard against an unexpected large body from a hijacking captive portal / proxy error page.
          if (body.length > 128) {
            done(() => reject(new Error('Egress probe response too large')));
            req.destroy();
          }
        });
        res.on('end', () => {
          const trimmed = body.trim();
          done(() => (trimmed ? resolve(trimmed) : reject(new Error('Egress probe returned an empty body'))));
        });
      });
      req.on('timeout', () => {
        done(() => reject(new Error(`Egress probe timed out after ${timeoutMs}ms`)));
        req.destroy();
      });
      req.on('error', err => done(() => reject(err)));
    });
    return { ip };
  } finally {
    agent?.destroy();
  }
}
