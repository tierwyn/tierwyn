import { createHash, generateKeyPairSync, sign } from 'crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { authPayload, packageAuthPayload } from '@tierwyn/shared';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { LoginRateLimiter } from '../auth/rateLimit.js';
import {
  createPendingHost,
  redeemEnrollToken,
  setRemoteHostStatus,
} from '../repositories/remoteHosts.js';
import { registerNodePackageRoutes } from './nodePackage.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'tierwyn-node-pkg-route-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const MARKER = 'TIERWYN_HUB_PKG_SHA256=""  # hub substitutes this line when serving /node/install.sh';
const TGZ_BYTES = Buffer.from('fake-tarball-bytes');
const SHA = createHash('sha256').update(TGZ_BYTES).digest('hex');
const BUILD_ID = 'f8b9ce65-deadbeef';
const FILE = `tierwyn-node-${BUILD_ID}.tgz`;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function writePkg(dir: string, opts?: { marker?: boolean }): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, FILE), TGZ_BYTES);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    buildId: BUILD_ID,
    sha256: SHA,
    size: TGZ_BYTES.length,
    file: FILE,
  }));
  const script = opts?.marker === false
    ? '#!/bin/bash\nset -euo pipefail\necho hi\n'
    : `#!/bin/bash\nset -euo pipefail\n${MARKER}\necho hi\n`;
  writeFileSync(join(dir, 'install.sh'), script);
}

function boot(opts: {
  packageDir?: string;
  now?: () => number;
  maxAttempts?: number;
} = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  const app = express();
  const clock = { t: 1_700_000_000_000, now: () => opts.now?.() ?? clock.t };
  const rateLimiter = new LoginRateLimiter({
    maxAttempts: opts.maxAttempts ?? 5,
    windowMs: 15 * 60_000,
    lockoutMs: 15 * 60_000,
    now: () => clock.now(),
  });
  registerNodePackageRoutes(app, {
    db: () => db,
    rateLimiter,
    packageDir: opts.packageDir,
    now: () => clock.now(),
  });
  return { db, app, clock };
}

function call(
  app: express.Express,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any; text: string; headers: Headers; buf: Buffer }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      fetch(`http://127.0.0.1:${port}${path}`, { method, headers })
        .then(async (r) => {
          const ab = await r.arrayBuffer();
          const buf = Buffer.from(ab);
          const text = buf.toString('utf8');
          let json: unknown;
          try { json = JSON.parse(text); } catch { json = undefined; }
          resolve({ status: r.status, json, text, headers: r.headers, buf });
        })
        .catch(reject)
        .finally(() => server.close());
    });
  });
}

function pendingToken(db: Database, token: string, expiresAt: number) {
  return createPendingHost(db, `host-${Math.random().toString(16).slice(2)}`, hashToken(token), expiresAt);
}

function enrolledHost(db: Database, now: number, origin = 'https://hub.example') {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const token = `tok-${Math.random().toString(16).slice(2)}`;
  const host = createPendingHost(db, `enr-${Math.random().toString(16).slice(2)}`, hashToken(token), now + 60_000);
  const enrolled = redeemEnrollToken(db, hashToken(token), now, {
    publicKey,
    hubOrigin: origin,
    hello: {},
  })!;
  return { host: enrolled, privateKey: pair.privateKey, publicKey, origin };
}

function signPkg(privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'], hostId: string, origin: string, ts: number) {
  return sign(null, Buffer.from(packageAuthPayload(hostId, origin, ts)), privateKey).toString('base64url');
}

describe('GET /node/install.sh', () => {
  it('substitutes the marker with manifest sha', async () => {
    const dir = tmp();
    writePkg(dir);
    const { app } = boot({ packageDir: dir });
    const res = await call(app, 'GET', '/node/install.sh');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/x-shellscript/);
    expect(res.text).toContain(`TIERWYN_HUB_PKG_SHA256="${SHA}"`);
    expect(res.text).not.toContain('TIERWYN_HUB_PKG_SHA256=""');
  });

  it('503 package_unavailable without manifest', async () => {
    const { app } = boot({ packageDir: tmp() });
    const res = await call(app, 'GET', '/node/install.sh');
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ code: 'package_unavailable' });
  });

  it('503 when the marker line is missing', async () => {
    const dir = tmp();
    writePkg(dir, { marker: false });
    const { app } = boot({ packageDir: dir });
    const res = await call(app, 'GET', '/node/install.sh');
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ code: 'package_unavailable' });
  });

  it('public — no auth needed', async () => {
    const dir = tmp();
    writePkg(dir);
    const { app } = boot({ packageDir: dir });
    const res = await call(app, 'GET', '/node/install.sh');
    expect(res.status).toBe(200);
  });
});

describe('GET /node/package.tgz token', () => {
  it('valid enroll token → 200 with sha + build headers and exact bytes', async () => {
    const dir = tmp();
    writePkg(dir);
    const { db, app, clock } = boot({ packageDir: dir });
    const token = 'enroll-token-valid';
    pendingToken(db, token, clock.now() + 60_000);
    const res = await call(app, 'GET', '/node/package.tgz', { authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-tierwyn-build-id')).toBe(BUILD_ID);
    expect(res.headers.get('x-tierwyn-package-sha256')).toBe(SHA);
    expect(res.headers.get('content-length')).toBe(String(TGZ_BYTES.length));
    expect(res.buf.equals(TGZ_BYTES)).toBe(true);
  });

  it('token remains redeemable afterwards', async () => {
    const dir = tmp();
    writePkg(dir);
    const { db, app, clock } = boot({ packageDir: dir });
    const token = 'still-good';
    pendingToken(db, token, clock.now() + 60_000);
    const res = await call(app, 'GET', '/node/package.tgz', { authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    const redeemed = redeemEnrollToken(db, hashToken(token), clock.now(), {
      publicKey: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      hubOrigin: 'https://hub.example',
      hello: {},
    });
    expect(redeemed).toBeTruthy();
  });

  it('expired → 401', async () => {
    const dir = tmp();
    writePkg(dir);
    const { db, app, clock } = boot({ packageDir: dir });
    const token = 'expired';
    pendingToken(db, token, clock.now() - 1);
    const res = await call(app, 'GET', '/node/package.tgz', { authorization: `Bearer ${token}` });
    expect(res.status).toBe(401);
  });

  it('already redeemed → 401', async () => {
    const dir = tmp();
    writePkg(dir);
    const { db, app, clock } = boot({ packageDir: dir });
    const token = 'spent';
    pendingToken(db, token, clock.now() + 60_000);
    redeemEnrollToken(db, hashToken(token), clock.now(), {
      publicKey: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      hubOrigin: 'https://hub.example',
      hello: {},
    });
    const res = await call(app, 'GET', '/node/package.tgz', { authorization: `Bearer ${token}` });
    expect(res.status).toBe(401);
  });

  it('?token= query is ignored → 401', async () => {
    const dir = tmp();
    writePkg(dir);
    const { db, app, clock } = boot({ packageDir: dir });
    const token = 'in-query';
    pendingToken(db, token, clock.now() + 60_000);
    const res = await call(app, 'GET', `/node/package.tgz?token=${token}`);
    expect(res.status).toBe(401);
  });
});

describe('GET /node/package.tgz signature', () => {
  it('valid sig from trusted host → 200', async () => {
    const dir = tmp();
    writePkg(dir);
    const { db, app, clock } = boot({ packageDir: dir });
    const { host, privateKey, origin } = enrolledHost(db, clock.now());
    setRemoteHostStatus(db, host.id, 'trusted');
    const ts = clock.now();
    const res = await call(app, 'GET', '/node/package.tgz', {
      'x-tierwyn-node-id': host.id,
      'x-tierwyn-node-ts': String(ts),
      'x-tierwyn-node-sig': signPkg(privateKey, host.id, origin, ts),
    });
    expect(res.status).toBe(200);
    expect(res.buf.equals(TGZ_BYTES)).toBe(true);
  });

  it('valid sig with new-node x-tierwyn-node-* headers → 200 (new node → new hub)', async () => {
    const dir = tmp();
    writePkg(dir);
    const { db, app, clock } = boot({ packageDir: dir });
    const { host, privateKey, origin } = enrolledHost(db, clock.now());
    setRemoteHostStatus(db, host.id, 'trusted');
    const ts = clock.now();
    const res = await call(app, 'GET', '/node/package.tgz', {
      'x-tierwyn-node-id': host.id,
      'x-tierwyn-node-ts': String(ts),
      'x-tierwyn-node-sig': signPkg(privateKey, host.id, origin, ts),
    });
    expect(res.status).toBe(200);
    expect(res.buf.equals(TGZ_BYTES)).toBe(true);
  });

  it('enrolled-not-trusted → 200', async () => {
    const dir = tmp();
    writePkg(dir);
    const { db, app, clock } = boot({ packageDir: dir });
    const { host, privateKey, origin } = enrolledHost(db, clock.now());
    const ts = clock.now();
    const res = await call(app, 'GET', '/node/package.tgz', {
      'x-tierwyn-node-id': host.id,
      'x-tierwyn-node-ts': String(ts),
      'x-tierwyn-node-sig': signPkg(privateKey, host.id, origin, ts),
    });
    expect(res.status).toBe(200);
  });

  it('unknown host → 401', async () => {
    const dir = tmp();
    writePkg(dir);
    const { app, clock } = boot({ packageDir: dir });
    const pair = generateKeyPairSync('ed25519');
    const ts = clock.now();
    const fakeId = '00000000-0000-4000-8000-000000000000';
    const res = await call(app, 'GET', '/node/package.tgz', {
      'x-tierwyn-node-id': fakeId,
      'x-tierwyn-node-ts': String(ts),
      'x-tierwyn-node-sig': signPkg(pair.privateKey, fakeId, 'https://hub.example', ts),
    });
    expect(res.status).toBe(401);
  });

  it('pending host (no key yet) → 401', async () => {
    const dir = tmp();
    writePkg(dir);
    const { db, app, clock } = boot({ packageDir: dir });
    const host = pendingToken(db, 'pending-tok', clock.now() + 60_000);
    const pair = generateKeyPairSync('ed25519');
    const ts = clock.now();
    const res = await call(app, 'GET', '/node/package.tgz', {
      'x-tierwyn-node-id': host.id,
      'x-tierwyn-node-ts': String(ts),
      'x-tierwyn-node-sig': signPkg(pair.privateKey, host.id, 'https://hub.example', ts),
    });
    expect(res.status).toBe(401);
  });

  it('ts 301 s old → 401', async () => {
    const dir = tmp();
    writePkg(dir);
    const { db, app, clock } = boot({ packageDir: dir });
    const { host, privateKey, origin } = enrolledHost(db, clock.now());
    const ts = clock.now() - 301_000;
    const res = await call(app, 'GET', '/node/package.tgz', {
      'x-tierwyn-node-id': host.id,
      'x-tierwyn-node-ts': String(ts),
      'x-tierwyn-node-sig': signPkg(privateKey, host.id, origin, ts),
    });
    expect(res.status).toBe(401);
  });

  it('signature over WS authPayload → 401', async () => {
    const dir = tmp();
    writePkg(dir);
    const { db, app, clock } = boot({ packageDir: dir });
    const { host, privateKey, origin } = enrolledHost(db, clock.now());
    const ts = clock.now();
    const sig = sign(null, Buffer.from(authPayload('nonce', host.id, origin)), privateKey).toString('base64url');
    const res = await call(app, 'GET', '/node/package.tgz', {
      'x-tierwyn-node-id': host.id,
      'x-tierwyn-node-ts': String(ts),
      'x-tierwyn-node-sig': sig,
    });
    expect(res.status).toBe(401);
  });

  it('sig for another hostId → 401', async () => {
    const dir = tmp();
    writePkg(dir);
    const { db, app, clock } = boot({ packageDir: dir });
    const a = enrolledHost(db, clock.now());
    const b = enrolledHost(db, clock.now());
    const ts = clock.now();
    const res = await call(app, 'GET', '/node/package.tgz', {
      'x-tierwyn-node-id': b.host.id,
      'x-tierwyn-node-ts': String(ts),
      'x-tierwyn-node-sig': signPkg(a.privateKey, b.host.id, b.origin, ts),
    });
    expect(res.status).toBe(401);
  });

  it('garbage sig → 401, no throw', async () => {
    const dir = tmp();
    writePkg(dir);
    const { db, app, clock } = boot({ packageDir: dir });
    const { host } = enrolledHost(db, clock.now());
    const res = await call(app, 'GET', '/node/package.tgz', {
      'x-tierwyn-node-id': host.id,
      'x-tierwyn-node-ts': String(clock.now()),
      'x-tierwyn-node-sig': '%%%not-a-signature%%%',
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /node/package.tgz guards', () => {
  it('rate limits repeated failures → 429 with Retry-After', async () => {
    const dir = tmp();
    writePkg(dir);
    const { app } = boot({ packageDir: dir, maxAttempts: 3 });
    for (let i = 0; i < 3; i++) {
      const r = await call(app, 'GET', '/node/package.tgz', { authorization: 'Bearer nope' });
      expect(r.status).toBe(401);
    }
    const locked = await call(app, 'GET', '/node/package.tgz', { authorization: 'Bearer nope' });
    expect(locked.status).toBe(429);
    expect(locked.headers.get('retry-after')).toBeTruthy();
  });

  it('503 when no manifest even with valid auth', async () => {
    const { db, app, clock } = boot({ packageDir: tmp() });
    const token = 'valid-but-no-pkg';
    pendingToken(db, token, clock.now() + 60_000);
    const res = await call(app, 'GET', '/node/package.tgz', { authorization: `Bearer ${token}` });
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ code: 'package_unavailable' });
  });
});
