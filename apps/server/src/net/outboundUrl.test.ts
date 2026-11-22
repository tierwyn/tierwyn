import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OutboundUrlError,
  assertOutboundUrl,
  outboundDns,
  safeFetch,
} from './outboundUrl.js';

const savedAllow = process.env.TIERWYN_OUTBOUND_ALLOW;

afterEach(() => {
  outboundDns.lookup = originalLookup;
  if (savedAllow === undefined) delete process.env.TIERWYN_OUTBOUND_ALLOW;
  else process.env.TIERWYN_OUTBOUND_ALLOW = savedAllow;
  vi.unstubAllGlobals();
});

const originalLookup = outboundDns.lookup;

function stubLookup(addrs: Array<{ address: string; family: number }>): void {
  outboundDns.lookup = (async () => addrs) as typeof outboundDns.lookup;
}

describe('assertOutboundUrl', () => {
  it('rejects ftp and userinfo', async () => {
    await expect(assertOutboundUrl('ftp://example.com/', 'public-only')).rejects.toBeInstanceOf(OutboundUrlError);
    await expect(assertOutboundUrl('https://user:pass@example.com/', 'public-only')).rejects.toBeInstanceOf(OutboundUrlError);
  });

  it('blocks metadata IPs under both policies', async () => {
    stubLookup([{ address: '169.254.169.254', family: 4 }]);
    await expect(assertOutboundUrl('http://metadata.example/', 'operator-endpoint')).rejects.toBeInstanceOf(OutboundUrlError);
    await expect(assertOutboundUrl('http://metadata.example/', 'public-only')).rejects.toBeInstanceOf(OutboundUrlError);
    stubLookup([{ address: '100.100.100.200', family: 4 }]);
    await expect(assertOutboundUrl('http://aliyun-meta/', 'operator-endpoint')).rejects.toBeInstanceOf(OutboundUrlError);
    stubLookup([{ address: 'fd00:ec2::254', family: 6 }]);
    await expect(assertOutboundUrl('http://aws-imds6/', 'operator-endpoint')).rejects.toBeInstanceOf(OutboundUrlError);
  });

  it('allows loopback for operator-endpoint and blocks it for public-only', async () => {
    stubLookup([{ address: '127.0.0.1', family: 4 }]);
    const ok = await assertOutboundUrl('http://127.0.0.1:5000/', 'operator-endpoint');
    expect(ok.href).toBe('http://127.0.0.1:5000/');
    await expect(assertOutboundUrl('http://127.0.0.1:5000/', 'public-only')).rejects.toBeInstanceOf(OutboundUrlError);
  });

  it('public-only requires https when httpsOnly is set', async () => {
    stubLookup([{ address: '1.2.3.4', family: 4 }]);
    await expect(assertOutboundUrl('http://push.example/', 'public-only', { httpsOnly: true }))
      .rejects.toBeInstanceOf(OutboundUrlError);
    await expect(assertOutboundUrl('https://push.example/', 'public-only', { httpsOnly: true }))
      .resolves.toMatchObject({ protocol: 'https:' });
  });

  it('TIERWYN_OUTBOUND_ALLOW bypasses a blocked target', async () => {
    process.env.TIERWYN_OUTBOUND_ALLOW = 'linklocal.example,169.254.0.0/16';
    stubLookup([{ address: '169.254.169.254', family: 4 }]);
    await expect(assertOutboundUrl('http://linklocal.example/', 'public-only')).resolves.toBeDefined();
  });

  it('blocks IPv4-mapped and IPv4-compatible IPv6 literals (hex and dotted)', async () => {
    const publicOnlyBlocked = [
      'http://[::ffff:7f00:1]/',
      'http://[::ffff:a9fe:a9fe]/',
      'http://[::ffff:a00:1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::127.0.0.1]/',
    ];
    for (const raw of publicOnlyBlocked) {
      await expect(assertOutboundUrl(raw, 'public-only'), raw).rejects.toBeInstanceOf(OutboundUrlError);
    }
    await expect(assertOutboundUrl('http://[::ffff:a9fe:a9fe]/', 'operator-endpoint'))
      .rejects.toBeInstanceOf(OutboundUrlError);
    await expect(assertOutboundUrl('http://[::ffff:7f00:1]/', 'operator-endpoint'))
      .resolves.toBeDefined();
  });
});

describe('safeFetch', () => {
  it('blocks a redirect to a metadata IP', async () => {
    stubLookup([{ address: '1.2.3.4', family: 4 }]);
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.startsWith('https://public.example')) {
        return new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/' } });
      }
      throw new Error(`unexpected fetch ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(safeFetch('https://public.example/x', {}, 'public-only', 5)).rejects.toBeInstanceOf(OutboundUrlError);
  });
});
