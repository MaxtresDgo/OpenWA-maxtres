import { parseProxyForResponse } from './session-response.dto';

describe('parseProxyForResponse', () => {
  it('returns null when no proxy URL is set', () => {
    expect(parseProxyForResponse(null)).toBeNull();
    expect(parseProxyForResponse(undefined)).toBeNull();
    expect(parseProxyForResponse('')).toBeNull();
  });

  it('returns null for an unparseable URL', () => {
    expect(parseProxyForResponse('not a url')).toBeNull();
  });

  it('exposes non-secret fields and never the password', () => {
    const dto = parseProxyForResponse('socks5://raspproxy8:s3cr3t@100.104.50.91:1080');
    expect(dto).toEqual({
      type: 'socks5',
      host: '100.104.50.91',
      port: 1080,
      username: 'raspproxy8',
      hasPassword: true,
    });
    // The raw password must not appear anywhere in the serialized DTO.
    expect(JSON.stringify(dto)).not.toContain('s3cr3t');
  });

  it('reports hasPassword false and username null for a bare proxy', () => {
    expect(parseProxyForResponse('http://proxy.local:8080')).toEqual({
      type: 'http',
      host: 'proxy.local',
      port: 8080,
      username: null,
      hasPassword: false,
    });
  });

  it('decodes percent-encoded usernames', () => {
    expect(parseProxyForResponse('socks5://us%40er:p@host:1080')?.username).toBe('us@er');
  });
});
