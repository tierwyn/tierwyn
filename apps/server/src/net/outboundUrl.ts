import { promises as dns } from 'dns';
import { envPref } from '../config/env.js';

export type OutboundPolicy =
  | 'operator-endpoint' // TTS sidecars, LLM base URLs: http(s); loopback+RFC1918 OK
  | 'public-only';      // /proxy, web-push: block loopback, RFC1918, CGNAT, link-local, ULA, multicast

export class OutboundUrlError extends Error {
  readonly code = 'outbound_url';
  constructor(message: string) {
    super(message);
    this.name = 'OutboundUrlError';
  }
}

/** Test seam — production uses dns.promises.lookup. */
export const outboundDns = {
  lookup: (host: string): Promise<Array<{ address: string; family: number }>> =>
    dns.lookup(host, { all: true }),
};

export interface AssertOutboundOpts {
  httpsOnly?: boolean;
}

function parseV4(addr: string): number | undefined {
  const parts = addr.split('.');
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return undefined;
    const v = Number(p);
    if (v > 255) return undefined;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function v4InCidr(ip: number, prefix: string, bits: number): boolean {
  const base = parseV4(prefix);
  if (base === undefined) return false;
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  return (ip & mask) === (base & mask);
}

function expandV6(addr: string): number[] | undefined {
  const lower = addr.toLowerCase();
  if (lower === '::') return Array(8).fill(0);
  const [head, tail] = lower.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  if (tail === undefined && h.length !== 8) return undefined;
  const fill = 8 - h.length - t.length;
  if (fill < 0) return undefined;
  const parts = [...h, ...Array(fill).fill('0'), ...t];
  if (parts.length !== 8) return undefined;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(p)) return undefined;
    out.push(parseInt(p, 16));
  }
  return out;
}

function v6Prefixed(addr: number[], prefix: string, bits: number): boolean {
  const p = expandV6(prefix);
  if (!p) return false;
  let left = bits;
  for (let i = 0; i < 8 && left > 0; i++) {
    const take = Math.min(16, left);
    const mask = take === 16 ? 0xFFFF : (0xFFFF << (16 - take)) & 0xFFFF;
    if ((addr[i]! & mask) !== (p[i]! & mask)) return false;
    left -= take;
  }
  return true;
}

function mappedV4(address: string): string | undefined {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return m?.[1];
}

function v4FromWords(w6: number, w7: number): string {
  return `${(w6 >> 8) & 0xff}.${w6 & 0xff}.${(w7 >> 8) & 0xff}.${w7 & 0xff}`;
}

/** IPv4-mapped (::ffff:0:0/96), deprecated IPv4-compatible (::/96 except ::/::1), NAT64 (64:ff9b::/96). */
function embeddedV4(addr: number[]): string | undefined {
  const w0 = addr[0]!;
  const w1 = addr[1]!;
  const w2 = addr[2]!;
  const w3 = addr[3]!;
  const w4 = addr[4]!;
  const w5 = addr[5]!;
  const w6 = addr[6]!;
  const w7 = addr[7]!;
  const mapped = w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0xffff;
  const nat64 = w0 === 0x64 && w1 === 0xff9b && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0;
  const compatible = w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0
    && !(w6 === 0 && (w7 === 0 || w7 === 1));
  if (mapped || nat64 || compatible) return v4FromWords(w6, w7);
  return undefined;
}

function alwaysBlockedV4(ip: number): boolean {
  if (v4InCidr(ip, '169.254.0.0', 16)) return true; // link-local
  if (v4InCidr(ip, '0.0.0.0', 8)) return true;
  if (ip === parseV4('100.100.100.200')) return true; // Aliyun metadata
  if (v4InCidr(ip, '224.0.0.0', 4)) return true; // multicast
  if (ip === 0xFFFFFFFF) return true; // broadcast
  return false;
}

function publicOnlyBlockedV4(ip: number): boolean {
  if (v4InCidr(ip, '127.0.0.0', 8)) return true;
  if (v4InCidr(ip, '10.0.0.0', 8)) return true;
  if (v4InCidr(ip, '172.16.0.0', 12)) return true;
  if (v4InCidr(ip, '192.168.0.0', 16)) return true;
  if (v4InCidr(ip, '100.64.0.0', 10)) return true; // CGNAT
  return false;
}

function alwaysBlockedV6(addr: number[]): boolean {
  if (v6Prefixed(addr, 'fe80::', 10)) return true; // link-local
  if (addr.every((w) => w === 0)) return true; // ::
  if (v6Prefixed(addr, 'ff00::', 8)) return true; // multicast
  const imds = expandV6('fd00:ec2::254');
  if (imds && addr.every((w, i) => w === imds[i])) return true;
  return false;
}

function publicOnlyBlockedV6(addr: number[]): boolean {
  if (addr[0] === 0 && addr[1] === 0 && addr[2] === 0 && addr[3] === 0
    && addr[4] === 0 && addr[5] === 0 && addr[6] === 0 && addr[7] === 1) return true; // ::1
  if (v6Prefixed(addr, 'fc00::', 7)) return true; // ULA
  return false;
}

function v4Blocked(ip: number, policy: OutboundPolicy): boolean {
  if (alwaysBlockedV4(ip)) return true;
  if (policy === 'public-only' && publicOnlyBlockedV4(ip)) return true;
  return false;
}

function addressBlocked(address: string, family: number, policy: OutboundPolicy): boolean {
  const asV4 = family === 4 ? address : mappedV4(address);
  if (asV4) {
    const ip = parseV4(asV4);
    if (ip === undefined) return true;
    return v4Blocked(ip, policy);
  }
  const v6 = expandV6(address);
  if (!v6) return true;
  const embedded = embeddedV4(v6);
  if (embedded) {
    const ip = parseV4(embedded);
    if (ip === undefined) return true;
    return v4Blocked(ip, policy);
  }
  if (alwaysBlockedV6(v6)) return true;
  if (policy === 'public-only' && publicOnlyBlockedV6(v6)) return true;
  return false;
}

function literalAddrs(host: string): Array<{ address: string; family: number }> | undefined {
  if (parseV4(host) !== undefined) return [{ address: host, family: 4 }];
  const inner = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (inner.includes(':') && expandV6(inner)) return [{ address: inner, family: 6 }];
  return undefined;
}

function allowList(): string[] {
  return (envPref('OUTBOUND_ALLOW') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

function hostAllowed(host: string, addrs: Array<{ address: string }>): boolean {
  const items = allowList();
  if (items.length === 0) return false;
  const h = host.toLowerCase();
  for (const item of items) {
    if (item.includes('/')) {
      const [prefix, bitsRaw] = item.split('/');
      const bits = Number(bitsRaw);
      if (!prefix || !Number.isInteger(bits)) continue;
      const v4p = parseV4(prefix);
      if (v4p !== undefined && bits >= 0 && bits <= 32) {
        for (const a of addrs) {
          const v4 = parseV4(mappedV4(a.address) ?? (a.address.includes(':') ? '' : a.address));
          if (v4 !== undefined && v4InCidr(v4, prefix, bits)) return true;
        }
      }
    } else if (item.toLowerCase() === h) {
      return true;
    }
  }
  return false;
}

export async function assertOutboundUrl(
  raw: string,
  policy: OutboundPolicy,
  opts: AssertOutboundOpts = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundUrlError('invalid url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OutboundUrlError('url must be http(s)');
  }
  if (opts.httpsOnly && url.protocol !== 'https:') {
    throw new OutboundUrlError('url must be https');
  }
  if (url.username || url.password) {
    throw new OutboundUrlError('url must not include credentials');
  }
  const host = url.hostname;
  if (!host) throw new OutboundUrlError('url host required');
  let addrs: Array<{ address: string; family: number }>;
  const literal = literalAddrs(host);
  if (literal) {
    addrs = literal;
  } else {
    try {
      addrs = await outboundDns.lookup(host);
    } catch {
      throw new OutboundUrlError('dns lookup failed');
    }
    if (!addrs.length) throw new OutboundUrlError('dns lookup returned no addresses');
  }
  if (hostAllowed(host, addrs)) return url;
  for (const a of addrs) {
    if (addressBlocked(a.address, a.family, policy)) {
      throw new OutboundUrlError(`destination not allowed (${a.address})`);
    }
  }
  return url;
}

export async function assertOperatorEndpointIfPresent(raw: unknown): Promise<void> {
  if (typeof raw !== 'string' || !raw.trim()) return;
  await assertOutboundUrl(raw.trim(), 'operator-endpoint');
}

export async function safeFetch(
  raw: string,
  init: RequestInit,
  policy: OutboundPolicy,
  maxRedirects = 0,
): Promise<Response> {
  let current = await assertOutboundUrl(raw, policy);
  let hops = 0;
  while (true) {
    const res = await fetch(current, { ...init, redirect: 'manual' });
    const loc = res.headers.get('Location');
    if (!loc || res.status < 300 || res.status >= 400 || hops >= maxRedirects) return res;
    hops += 1;
    let next: URL;
    try {
      next = new URL(loc, current);
    } catch {
      throw new OutboundUrlError('invalid redirect location');
    }
    current = await assertOutboundUrl(next.href, policy);
  }
}
