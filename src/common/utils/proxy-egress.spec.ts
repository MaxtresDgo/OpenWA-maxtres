import * as http from 'http';
import * as net from 'net';
import { fetchEgressIp } from './proxy-egress';

/** Spin a throwaway HTTP server returning a fixed body, for direct (no-proxy) egress probing. */
function makeProbeServer(body: string, status = 200): Promise<{ url: string; close: () => void }> {
  return new Promise(resolve => {
    const server = http.createServer((_req, res) => {
      res.statusCode = status;
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
    });
  });
}

describe('fetchEgressIp', () => {
  it('returns the trimmed body as the IP for a direct request', async () => {
    const probe = await makeProbeServer('203.0.113.7\n');
    try {
      await expect(fetchEgressIp(undefined, { probeUrl: probe.url })).resolves.toEqual({ ip: '203.0.113.7' });
    } finally {
      probe.close();
    }
  });

  it('rejects on a non-200 response', async () => {
    const probe = await makeProbeServer('nope', 502);
    try {
      await expect(fetchEgressIp(undefined, { probeUrl: probe.url })).rejects.toThrow(/HTTP 502/);
    } finally {
      probe.close();
    }
  });

  it('rejects on an empty body', async () => {
    const probe = await makeProbeServer('   ');
    try {
      await expect(fetchEgressIp(undefined, { probeUrl: probe.url })).rejects.toThrow(/empty/);
    } finally {
      probe.close();
    }
  });

  it('rejects an oversized (hijacked) response body', async () => {
    const probe = await makeProbeServer('x'.repeat(500));
    try {
      await expect(fetchEgressIp(undefined, { probeUrl: probe.url })).rejects.toThrow(/too large/);
    } finally {
      probe.close();
    }
  });

  it('times out against a black-hole endpoint', async () => {
    // A server that accepts the connection but never responds.
    const server = net.createServer(() => {});
    const port = await new Promise<number>(resolve =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)),
    );
    try {
      await expect(fetchEgressIp(undefined, { probeUrl: `http://127.0.0.1:${port}`, timeoutMs: 200 })).rejects.toThrow(
        /timed out/,
      );
    } finally {
      server.close();
    }
  });
});
