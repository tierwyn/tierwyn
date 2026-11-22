import { createHash, generateKeyPairSync, verify, createPublicKey } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { packageAuthPayload } from '@tierwyn/shared';
import { packageFetch } from './packageFetch.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'tierwyn-pkg-fetch-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function enrollDir(over: Record<string, unknown> = {}) {
  const d = tmp();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(join(d, 'key'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(join(d, 'node.json'), JSON.stringify({
    hubUrl: 'https://hub.example/path',
    hostId: 'host-1',
    roots: [],
    allowedAgents: [],
    ...over,
  }));
  return {
    d,
    publicKey,
    hostId: String(over.hostId ?? 'host-1'),
    hubUrl: String(over.hubUrl ?? 'https://hub.example/path'),
  };
}

function sha(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('packageFetch', () => {
  it('signs with stored key and hubOrigin', async () => {
    const { d, publicKey, hostId } = enrollDir();
    const body = Buffer.from('pkg-bytes');
    let seen: { url: string; headers: Headers } | undefined;
    const fetchFn = async (url: string | URL, init?: RequestInit) => {
      seen = { url: String(url), headers: new Headers(init?.headers) };
      const ts = Number(seen.headers.get('x-tierwyn-node-ts'));
      const sig = seen.headers.get('x-tierwyn-node-sig') ?? '';
      const origin = new URL('https://hub.example/path').origin;
      expect(seen.headers.get('x-tierwyn-node-id')).toBe(hostId);
      expect(seen.headers.get('x-tierwyn-node-ts')).toBe(String(ts));
      expect(seen.headers.get('x-tierwyn-node-sig')).toBe(sig);
      expect(verify(
        null,
        Buffer.from(packageAuthPayload(hostId, origin, ts)),
        publicKey,
        Buffer.from(sig, 'base64url'),
      )).toBe(true);
      expect(seen.url).toBe('https://hub.example/node/package.tgz');
      return {
        ok: true,
        status: 200,
        headers: new Headers({
          'x-tierwyn-build-id': 'bid-1',
          'x-tierwyn-package-sha256': sha(body),
        }),
        body: new ReadableStream({
          start(c) { c.enqueue(body); c.close(); },
        }),
      } as Response;
    };
    const out = join(tmp(), 'pkg.tgz');
    const r = await packageFetch({ dir: d, out }, fetchFn as typeof fetch);
    expect(r.buildId).toBe('bid-1');
    expect(readFileSync(out).equals(body)).toBe(true);
    expect(existsSync(`${out}.part`)).toBe(false);
  });

  it('writes file and returns build id', async () => {
    const { d } = enrollDir();
    const body = Buffer.from('abc');
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      headers: new Headers({
        'x-tierwyn-build-id': 'id-x',
        'x-tierwyn-package-sha256': sha(body),
      }),
      body: new ReadableStream({ start(c) { c.enqueue(body); c.close(); } }),
    } as Response);
    const out = join(tmp(), 'out.tgz');
    await expect(packageFetch({ dir: d, out }, fetchFn as typeof fetch)).resolves.toEqual({ buildId: 'id-x' });
    expect(readFileSync(out).equals(body)).toBe(true);
  });

  it('sha mismatch → throws, out file absent', async () => {
    const { d } = enrollDir();
    const out = join(tmp(), 'bad.tgz');
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      headers: new Headers({
        'x-tierwyn-build-id': 'id',
        'x-tierwyn-package-sha256': 'ab'.repeat(32),
      }),
      body: new ReadableStream({ start(c) { c.enqueue(Buffer.from('nope')); c.close(); } }),
    } as Response);
    await expect(packageFetch({ dir: d, out }, fetchFn as typeof fetch)).rejects.toThrow(/sha/i);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.part`)).toBe(false);
  });

  it('HTTP error → throws, out file absent', async () => {
    const { d } = enrollDir();
    const out = join(tmp(), 'err.tgz');
    const fetchFn = async () => ({
      ok: false,
      status: 401,
      headers: new Headers(),
      body: null,
    } as Response);
    await expect(packageFetch({ dir: d, out }, fetchFn as typeof fetch)).rejects.toThrow(/401/);
    expect(existsSync(out)).toBe(false);
  });

  it('body over 64 MiB → aborts', async () => {
    const { d } = enrollDir();
    const out = join(tmp(), 'big.tgz');
    const chunk = Buffer.alloc(1024 * 1024, 1);
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      headers: new Headers({
        'x-tierwyn-build-id': 'id',
        'x-tierwyn-package-sha256': 'ab'.repeat(32),
      }),
      body: (async function* () {
        for (let i = 0; i < 65; i++) yield chunk;
      })(),
    } as unknown as Response);
    await expect(packageFetch({ dir: d, out }, fetchFn as typeof fetch)).rejects.toThrow(/64/i);
    expect(existsSync(out)).toBe(false);
  });

  it('http hub without allowHttpPackage → refuses before any fetch', async () => {
    const { d } = enrollDir({ hubUrl: 'http://hub.example' });
    let called = 0;
    const fetchFn = async () => { called += 1; throw new Error('should not fetch'); };
    await expect(packageFetch({ dir: d, out: join(tmp(), 'x.tgz') }, fetchFn as typeof fetch))
      .rejects.toThrow(/allow-http|http/i);
    expect(called).toBe(0);
  });

  it('http hub with it → proceeds', async () => {
    const { d } = enrollDir({ hubUrl: 'http://hub.example', allowHttpPackage: true });
    const body = Buffer.from('http-ok');
    const fetchFn = async (url: string | URL) => {
      expect(String(url)).toBe('http://hub.example/node/package.tgz');
      return {
        ok: true,
        status: 200,
        headers: new Headers({
          'x-tierwyn-build-id': 'http-id',
          'x-tierwyn-package-sha256': sha(body),
        }),
        body: new ReadableStream({ start(c) { c.enqueue(body); c.close(); } }),
      } as Response;
    };
    const out = join(tmp(), 'http.tgz');
    await expect(packageFetch({ dir: d, out }, fetchFn as typeof fetch)).resolves.toEqual({ buildId: 'http-id' });
  });

  it('--allow-http persists allowHttpPackage then fetches an http hub', async () => {
    const { d } = enrollDir({ hubUrl: 'http://hub.example' });
    const body = Buffer.from('persist-ok');
    let called = 0;
    const fetchFn = async () => {
      called += 1;
      return {
        ok: true,
        status: 200,
        headers: new Headers({
          'x-tierwyn-build-id': 'persist-id',
          'x-tierwyn-package-sha256': sha(body),
        }),
        body: new ReadableStream({ start(c) { c.enqueue(body); c.close(); } }),
      } as Response;
    };
    const out = join(tmp(), 'persist.tgz');
    await expect(packageFetch({ dir: d, out, allowHttp: true }, fetchFn as typeof fetch))
      .resolves.toEqual({ buildId: 'persist-id' });
    expect(called).toBe(1);
    expect(JSON.parse(readFileSync(join(d, 'node.json'), 'utf8')).allowHttpPackage).toBe(true);
  });

  it('does not follow a 302', async () => {
    const body = Buffer.from('redirect-body');
    const servers: Server[] = [];
    const listen = (server: Server) => new Promise<number>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') resolve(addr.port);
        else reject(new Error('no port'));
      });
      server.on('error', reject);
    });
    try {
      let destHits = 0;
      const dest = createServer((_req, res) => {
        destHits += 1;
        res.setHeader('x-tierwyn-build-id', 'redir-id');
        res.setHeader('x-tierwyn-package-sha256', sha(body));
        res.end(body);
      });
      servers.push(dest);
      const destPort = await listen(dest);
      const origin = createServer((_req, res) => {
        res.statusCode = 302;
        res.setHeader('location', `http://127.0.0.1:${destPort}/node/package.tgz`);
        res.end();
      });
      servers.push(origin);
      const originPort = await listen(origin);
      const { d } = enrollDir({
        hubUrl: `http://127.0.0.1:${originPort}`,
        allowHttpPackage: true,
      });
      const out = join(tmp(), 'redir.tgz');
      await expect(packageFetch({ dir: d, out })).rejects.toThrow();
      expect(destHits).toBe(0);
      expect(existsSync(out)).toBe(false);
    } finally {
      await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    }
  });
});
