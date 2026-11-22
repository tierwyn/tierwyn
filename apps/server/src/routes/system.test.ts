import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { tmpdir } from 'os';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { Server } from 'http';
import type { SystemResources } from '@tierwyn/shared';
import { requireAuth } from '../auth/middleware.js';
import { registerSystemRoutes, getSystemResources } from './system.js';

let server: Server;
let base: string;

beforeEach(async () => {
  const app = express();
  registerSystemRoutes(app, { dataDir: tmpdir() });
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

describe('GET /system/resources', () => {
  it('returns a coherent snapshot', async () => {
    const res = await fetch(`${base}/system/resources`);
    expect(res.status).toBe(200);
    const body = await res.json() as SystemResources;

    expect(body.cpu.cores).toBeGreaterThan(0);
    expect(body.cpu.load1).toBeGreaterThanOrEqual(0);
    expect(body.memory.total).toBeGreaterThan(0);
    expect(body.memory.used).toBe(body.memory.total - body.memory.free);
    expect(body.memory.used).toBeLessThanOrEqual(body.memory.total);
    expect(body.proc.rss).toBeGreaterThan(0);
    expect(body.proc.heapUsed).toBeLessThanOrEqual(body.proc.heapTotal);
    expect(body.proc.pid).toBe(process.pid);
    expect(body.os.platform).toBe(process.platform);
    expect(body.now).toBeGreaterThan(0);
  });

  it('reports the data volume or null, never a broken shape', async () => {
    const body = await getSystemResources(tmpdir());
    if (body.disk) {
      expect(body.disk.path).toBe(tmpdir());
      expect(body.disk.total).toBeGreaterThan(0);
      expect(body.disk.used).toBeLessThanOrEqual(body.disk.total);
      expect(body.disk.available).toBeLessThanOrEqual(body.disk.total);
    } else {
      expect(body.disk).toBeNull();
    }
  });

  it('degrades to null disk on an unreadable path', async () => {
    const body = await getSystemResources('/definitely/not/a/real/path/tierwyn-test');
    expect(body.disk).toBeNull();
    expect(body.cpu.cores).toBeGreaterThan(0); // rest of the snapshot survives
  });
});

describe('GET /system/resources auth', () => {
  it('returns 401 without a cookie when requireAuth is configured', async () => {
    const app = express();
    app.use(requireAuth({
      disabled: false,
      configured: true,
      sessionSecret: 'unit-test-session-secret-value-32bytes',
      passwordHash: 'not-used',
      cookieSecure: false,
    }));
    registerSystemRoutes(app, { dataDir: tmpdir() });
    const authed = app.listen(0);
    const port = (authed.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/system/resources`);
      expect(r.status).toBe(401);
    } finally {
      await new Promise<void>((r) => authed.close(() => r()));
    }
  });

  it('registerSystemRoutes is after requireAuth in index.ts', () => {
    const indexPath = join(dirname(fileURLToPath(import.meta.url)), '../index.ts');
    const src = readFileSync(indexPath, 'utf8');
    const authIdx = src.indexOf('app.use(requireAuth(authConfig))');
    const systemIdx = src.indexOf('registerSystemRoutes(app');
    expect(authIdx).toBeGreaterThan(-1);
    expect(systemIdx).toBeGreaterThan(-1);
    expect(systemIdx).toBeGreaterThan(authIdx);
  });
});
