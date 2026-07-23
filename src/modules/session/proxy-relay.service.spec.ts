import * as net from 'net';
import { ProxyRelayService, parseRelayUpstream } from './proxy-relay.service';

/**
 * Minimal SOCKS5 upstream that REQUIRES username/password auth, records the credentials it received,
 * and — once past the CONNECT request — echoes any bytes back. Stands in for microsocks so the relay's
 * credential injection and transparent piping can be asserted end-to-end without a real proxy.
 */
function makeMockSocks5(
  expectUser: string,
  expectPass: string,
): Promise<{
  port: number;
  close: () => void;
  received: { user?: string; pass?: string; authOk?: boolean };
}> {
  const received: { user?: string; pass?: string; authOk?: boolean } = {};
  return new Promise(resolve => {
    const server = net.createServer(sock => {
      let stage: 'greeting' | 'auth' | 'request' | 'pipe' = 'greeting';
      const onData = (data: Buffer): void => {
        if (stage === 'greeting') {
          // [VER, NMETHODS, METHODS...] — demand username/password (0x02).
          const methods = data.subarray(2, 2 + data[1]);
          sock.write(Buffer.from([0x05, methods.includes(0x02) ? 0x02 : 0xff]));
          stage = 'auth';
        } else if (stage === 'auth') {
          // [0x01, ulen, user, plen, pass]
          const ulen = data[1];
          received.user = data.subarray(2, 2 + ulen).toString();
          const plen = data[2 + ulen];
          received.pass = data.subarray(3 + ulen, 3 + ulen + plen).toString();
          const ok = received.user === expectUser && received.pass === expectPass;
          received.authOk = ok;
          sock.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
          stage = ok ? 'request' : 'greeting';
          if (!ok) sock.destroy();
        } else if (stage === 'request') {
          // CONNECT request — reply success with a bogus bound address, then echo.
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          stage = 'pipe';
        } else {
          sock.write(data); // echo
        }
      };
      sock.on('data', onData);
      sock.on('error', () => sock.destroy());
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ port: addr.port, close: () => server.close(), received });
    });
  });
}

/** Drive a no-auth SOCKS5 handshake + CONNECT through the relay, send a payload, resolve the echo. */
function throughRelay(relayUrl: string, payload: string): Promise<string> {
  const { hostname, port } = new URL(relayUrl);
  return new Promise((resolve, reject) => {
    const sock = net.connect(parseInt(port, 10), hostname, () => {
      sock.write(Buffer.from([0x05, 0x01, 0x00])); // greeting: 1 method, no-auth
    });
    const timer = setTimeout(() => reject(new Error('relay test timed out')), 4000);
    let stage: 'method' | 'reply' | 'echo' = 'method';
    sock.on('data', data => {
      if (stage === 'method') {
        // expect [0x05, 0x00]
        // Send a CONNECT request for an arbitrary host:port (relay forwards it verbatim).
        sock.write(Buffer.from([0x05, 0x01, 0x00, 0x03, 0x0b, ...Buffer.from('example.com'), 0x00, 0x50]));
        stage = 'reply';
      } else if (stage === 'reply') {
        // upstream's CONNECT success reply — now send the payload
        sock.write(Buffer.from(payload));
        stage = 'echo';
      } else {
        clearTimeout(timer);
        resolve(data.toString());
        sock.destroy();
      }
    });
    sock.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('parseRelayUpstream', () => {
  it('returns null for non-SOCKS5 schemes', () => {
    expect(parseRelayUpstream('http://user:pass@host:8080')).toBeNull();
    expect(parseRelayUpstream('https://user:pass@host:8080')).toBeNull();
    expect(parseRelayUpstream('socks4://user@host:1080')).toBeNull();
  });

  it('returns null for credential-less SOCKS5 (Chromium handles it directly)', () => {
    expect(parseRelayUpstream('socks5://host:1080')).toBeNull();
  });

  it('returns null for a malformed URL', () => {
    expect(parseRelayUpstream('not a url')).toBeNull();
  });

  it('parses a credentialed SOCKS5 upstream, decoding percent-encoding', () => {
    expect(parseRelayUpstream('socks5://ras%40p:m4x%3Atr@100.104.50.91:1080')).toEqual({
      host: '100.104.50.91',
      port: 1080,
      username: 'ras@p',
      password: 'm4x:tr',
    });
  });

  it('defaults the port to 1080 when absent', () => {
    expect(parseRelayUpstream('socks5://user:pass@host')).toMatchObject({ port: 1080 });
  });
});

describe('ProxyRelayService.resolveEngineProxyUrl', () => {
  let service: ProxyRelayService;

  beforeEach(() => {
    service = new ProxyRelayService();
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('returns undefined when no proxy is configured', async () => {
    await expect(service.resolveEngineProxyUrl(undefined)).resolves.toBeUndefined();
    await expect(service.resolveEngineProxyUrl(null)).resolves.toBeUndefined();
    await expect(service.resolveEngineProxyUrl('')).resolves.toBeUndefined();
  });

  it('passes non-credentialed / non-SOCKS proxies straight through', async () => {
    await expect(service.resolveEngineProxyUrl('http://user:pass@host:8080')).resolves.toBe(
      'http://user:pass@host:8080',
    );
    await expect(service.resolveEngineProxyUrl('socks5://host:1080')).resolves.toBe('socks5://host:1080');
  });

  it('returns a loopback relay URL for a credentialed SOCKS5 proxy', async () => {
    const url = await service.resolveEngineProxyUrl('socks5://user:pass@127.0.0.1:1080');
    expect(url).toMatch(/^socks5:\/\/127\.0\.0\.1:\d+$/);
  });

  it('reuses one relay (same port) for the same upstream URL', async () => {
    const a = await service.resolveEngineProxyUrl('socks5://user:pass@127.0.0.1:1080');
    const b = await service.resolveEngineProxyUrl('socks5://user:pass@127.0.0.1:1080');
    expect(a).toBe(b);
  });

  it('injects credentials to the upstream and pipes traffic transparently', async () => {
    const upstream = await makeMockSocks5('raspproxy8', 's3cr3t');
    try {
      const relayUrl = await service.resolveEngineProxyUrl(`socks5://raspproxy8:s3cr3t@127.0.0.1:${upstream.port}`);
      const echoed = await throughRelay(relayUrl as string, 'ping-through-tunnel');
      expect(echoed).toBe('ping-through-tunnel');
      expect(upstream.received.authOk).toBe(true);
      expect(upstream.received.user).toBe('raspproxy8');
      expect(upstream.received.pass).toBe('s3cr3t');
    } finally {
      upstream.close();
    }
  });
});
